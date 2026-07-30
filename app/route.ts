import fs from 'node:fs';
import path from 'node:path';

export const dynamic = 'force-dynamic';

/**
 * Serves the traveller app at the root.
 *
 * This is a Route Handler, not a page, and that is deliberate. The app is a
 * complete self contained HTML document. Rendering it through React would
 * mean dangerouslySetInnerHTML, and the browser does not execute <script>
 * tags injected that way, so the app would paint and then do nothing.
 * Returning the document verbatim lets the browser parse it normally.
 *
 * Do not replace this with a rewrite from '/' to '/app.html'. That resolves
 * under `next start` locally but 404s through Vercel's routing layer.
 */
const FILE = path.join(process.cwd(), 'public', 'app.html');

export async function GET() {
  let html: string;
  try {
    html = fs.readFileSync(FILE, 'utf8');
  } catch {
    return new Response(diagnostic(), {
      status: 500,
      headers: { 'content-type': 'text/html; charset=utf-8' }
    });
  }
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=0, must-revalidate'
    }
  });
}

function diagnostic(): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Voyara . deployment issue</title></head>
<body style="font-family:ui-monospace,Menlo,monospace;background:#08090B;color:#EDEEF0;margin:0;padding:48px 24px;line-height:1.7">
<h1 style="font-weight:300;letter-spacing:.2em;font-size:22px">VOYARA</h1>
<p style="color:#E8A33D;margin-top:24px">The traveller app file is missing from this deployment.</p>
<p style="color:#84898F;font-size:13px">Expected at public/app.html</p>
<p style="color:#84898F;font-size:13px;margin-top:20px">This almost always means public/app.html was not committed to the repository. Confirm the file exists on GitHub, then redeploy.</p>
<p style="margin-top:28px"><a href="/api/health" style="color:#8FB4E3">Check API health</a></p>
</body></html>`;
}
