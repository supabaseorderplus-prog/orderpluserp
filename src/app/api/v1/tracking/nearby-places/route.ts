import { NextRequest, NextResponse } from "next/server";

type OverpassPlaceElement = {
  id: number;
  type: string;
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: { name?: string; place?: string };
};

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const latitude = Number(request.nextUrl.searchParams.get("lat"));
  const longitude = Number(request.nextUrl.searchParams.get("lon"));

  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return NextResponse.json(
      { success: false, message: "Valid latitude and longitude are required" },
      { status: 400 },
    );
  }

  const query = `[out:json][timeout:15];node(around:15000,${latitude},${longitude})["place"]["name"];out 120;`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 18000);

  try {
    const response = await fetch(
      `https://overpass.kumi.systems/api/interpreter?data=${encodeURIComponent(query)}`,
      {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": "OrderPlusERP/1.0 nearby-place-labels",
        },
        next: { revalidate: 3600 },
      },
    );

    if (!response.ok) {
      return NextResponse.json(
        { success: false, message: "Nearby place data is temporarily unavailable" },
        { status: 502 },
      );
    }

    const data = (await response.json()) as { elements?: OverpassPlaceElement[] };
    return NextResponse.json(
      { success: true, elements: data.elements || [] },
      {
        headers: {
          "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
        },
      },
    );
  } catch {
    return NextResponse.json(
      { success: false, message: "Nearby place data is temporarily unavailable" },
      { status: 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}
