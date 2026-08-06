export default function NotFound() {
  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '2rem', background: '#0a0a0f', color: '#f5f1e8', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ maxWidth: 480, textAlign: 'center' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 700, marginBottom: '0.75rem' }}>Page not found</h1>
        <p style={{ opacity: 0.8 }}>The page you requested does not exist.</p>
      </div>
    </main>
  );
}
