'use client';

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '2rem', background: '#0a0a0f', color: '#f5f1e8', fontFamily: 'system-ui, sans-serif' }}>
          <div style={{ maxWidth: 480, textAlign: 'center' }}>
            <h1 style={{ fontSize: '2rem', fontWeight: 700, marginBottom: '0.75rem' }}>Something went wrong</h1>
            <p style={{ opacity: 0.8, marginBottom: '1.25rem' }}>The application hit an unexpected error.</p>
            <button
              onClick={() => reset()}
              style={{ padding: '0.75rem 1rem', borderRadius: 12, border: '1px solid rgba(255,255,255,0.12)', background: '#111118', color: '#f5f1e8', cursor: 'pointer' }}
            >
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
