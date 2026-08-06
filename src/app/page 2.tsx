import Link from "next/link";

export default function HomePage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "#fefce8",
        color: "#18181b",
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      }}
    >
      <section style={{ width: "100%", maxWidth: 860, textAlign: "center" }}>
        <img
          src="/order-plus-logo.png"
          alt="Order Plus ERP logo"
          style={{
            width: "min(420px, 85vw)",
            height: "auto",
            borderRadius: 20,
            boxShadow: "0 24px 60px rgba(234, 88, 12, 0.30)",
          }}
        />
        <p
          style={{
            margin: "32px 0 10px",
            color: "#b45309",
            fontSize: 13,
            fontWeight: 800,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
          }}
        >
          HomeTech Chemical
        </p>
        <h1 style={{ margin: 0, fontSize: "clamp(2.5rem, 7vw, 5rem)", lineHeight: 1, letterSpacing: "-0.04em" }}>
          Order Plus ERP
        </h1>
        <p style={{ maxWidth: 620, margin: "22px auto 0", color: "#52525b", fontSize: 17, lineHeight: 1.7 }}>
          Manage orders, parties, payments, sales teams, inventory, and dispatch from one secure portal.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 12, marginTop: 36 }}>
          <Link href="/login" style={primaryLinkStyle}>
            Open Login Portal
          </Link>
          <Link href="/salesman" style={secondaryLinkStyle}>
            Salesman Login
          </Link>
          <Link href="/forgot-password" style={secondaryLinkStyle}>
            Forgot Password
          </Link>
        </div>
      </section>
    </main>
  );
}

const primaryLinkStyle = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 46,
  padding: "0 20px",
  borderRadius: 14,
  background: "#18181b",
  color: "#fff",
  fontSize: 14,
  fontWeight: 800,
  textDecoration: "none",
  boxShadow: "0 18px 35px rgba(24, 24, 27, 0.18)",
};

const secondaryLinkStyle = {
  ...primaryLinkStyle,
  background: "rgba(255, 255, 255, 0.65)",
  color: "#27272a",
  border: "1px solid rgba(24, 24, 27, 0.14)",
  boxShadow: "none",
};
