import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, getUserFromToken, resolveCompanyScope, listAllAuthUsers } from "@/lib/supabase-server";

// GET /api/v1/tracking/drivers — list drivers with their sessions, locations, and active lots
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const date = searchParams.get("date") || new Date().toISOString().split("T")[0];

  const authUser = await getUserFromToken(req);
  const companyId = await resolveCompanyScope(req, authUser);

  if (!companyId) {
    return NextResponse.json({ error: "Unauthorized: no company scope" }, { status: 403 });
  }

  // Resolve all party IDs under this company
  const { data: tree } = await supabaseAdmin.rpc("get_party_descendants", { root_id: companyId });
  const companyPartyIds: string[] = tree && tree.length > 0 ? tree.map((r: { id: string }) => r.id) : [];
  if (!companyPartyIds.includes(companyId)) companyPartyIds.push(companyId);

  // companyPartyIds will always have at least companyId

  // Get DRIVER users via auth metadata
  const authUsers = await listAllAuthUsers();
  const driverAuthIds = new Set(
    authUsers.filter(u => u.user_metadata?.display_role === "DRIVER").map(u => u.id)
  );

  if (driverAuthIds.size === 0) return NextResponse.json({ data: [] });

  // Fetch driver records from users, scoped to company
  const { data: driverList, error: driverErr } = await supabaseAdmin
    .from("users")
    .select("id, name, email, phone, party_id")
    .in("id", Array.from(driverAuthIds))
    .in("party_id", companyPartyIds);

  if (driverErr) return NextResponse.json({ error: driverErr.message }, { status: 500 });
  if (!driverList?.length) return NextResponse.json({ data: [] });

  const driverIds = driverList.map(d => d.id);

  // Get today's sessions
  const { data: sessions } = await supabaseAdmin
    .from("salesman_day_sessions")
    .select("*")
    .eq("date", date)
    .in("salesman_id", driverIds);

  // IST-aware start boundary
  const [dy, dm, dd] = date.split("-").map(Number);
  const startIST = new Date(Date.UTC(dy, dm - 1, dd, 0, 0, 0, 0) - 5.5 * 60 * 60 * 1000);

  // Load delivery lots from localStorage isn't possible server-side.
  // Instead, we attach lot info per driver based on the lot number stored in session notes.
  // Drivers store their active lot_id in session notes when they start duty.

  const driversWithStatus = await Promise.all(
    driverList.map(async (d) => {
      const session = sessions?.find(s => s.salesman_id === d.id) || null;

      const { data: latestLoc } = await supabaseAdmin
        .from("salesman_location_logs")
        .select("latitude, longitude, accuracy, speed, heading, address, activity, battery_level, recorded_at")
        .eq("salesman_id", d.id)
        .gte("recorded_at", startIST.toISOString())
        .order("recorded_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      // Compute trail distance
      let computed_distance_km = session?.total_distance_km ?? 0;
      if (!computed_distance_km) {
        const { data: trailLogs } = await supabaseAdmin
          .from("salesman_location_logs")
          .select("latitude, longitude")
          .eq("salesman_id", d.id)
          .gte("recorded_at", startIST.toISOString())
          .order("recorded_at", { ascending: true });

        if (trailLogs && trailLogs.length > 1) {
          let dist = 0;
          for (let i = 1; i < trailLogs.length; i++) {
            const R = 6371;
            const lat1 = trailLogs[i-1].latitude, lng1 = trailLogs[i-1].longitude;
            const lat2 = trailLogs[i].latitude, lng2 = trailLogs[i].longitude;
            const dLat = ((lat2 - lat1) * Math.PI) / 180;
            const dLng = ((lng2 - lng1) * Math.PI) / 180;
            const a =
              Math.sin(dLat / 2) ** 2 +
              Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
              Math.sin(dLng / 2) ** 2;
            dist += R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
          }
          computed_distance_km = parseFloat(dist.toFixed(2));
        }
      }

      // Parse lot_number from session notes (format: "LOT:LOT-XXXXXX|DEST:destination")
      let active_lot: { lot_number: string; destination: string } | null = null;
      if (session?.notes) {
        const lotMatch = session.notes.match(/LOT:([^|]+)/);
        const destMatch = session.notes.match(/DEST:(.+)/);
        if (lotMatch) active_lot = {
          lot_number: lotMatch[1],
          destination: destMatch?.[1] || "",
        };
      }

      return {
        ...d,
        role: "DRIVER",
        session: session ? { ...session, total_distance_km: computed_distance_km } : null,
        latest_location: latestLoc || null,
        active_lot,
      };
    })
  );

  return NextResponse.json({ data: driversWithStatus });
}
