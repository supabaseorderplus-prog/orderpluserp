async function test() {
  try {
    const res = await fetch('http://localhost:3000/');
    console.log(`Landing page: ${res.status} ${res.ok ? 'OK' : 'FAIL'}`);
    const html = await res.text();
    console.log(`HTML size: ${html.length} bytes`);
    console.log(`Contains gold-gradient: ${html.includes('gold-gradient')}`);
    console.log(`Contains obsidian: ${html.includes('obsidian')}`);
    console.log(`Contains glass-card: ${html.includes('glass-card')}`);
    console.log(`Contains Syne font: ${html.includes('Syne')}`);
  } catch (e) {
    console.error('Error:', e.message);
  }
}
test();
