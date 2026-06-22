export async function onRequest(context) {
  const { request, env } = context;

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: cors });
  }

  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });

  // ── AUTH ──────────────────────────────────────────────────────────────────
  const pw = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!pw || pw !== env.PASSWORD) {
    return json({ error: 'Unauthorized' }, 401);
  }

  try {
    const body = await request.json();
    const { action, repo, path, content, message } = body;

    if (action === 'auth') return json({ ok: true });

    // Cloudflare Workers actions don't need a GitHub repo
    if (!repo && action !== 'cf') {
      return json({ error: 'No repo specified' }, 400);
    }
    const [owner, repoName] = repo ? repo.split('/') : [null, null];

    const gh = (url, opts = {}) =>
      fetch(`https://api.github.com${url}`, {
        ...opts,
        headers: {
          Authorization: `token ${env.GITHUB_TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent': 'octave-deployer',
          Accept: 'application/vnd.github.v3+json',
          ...(opts.headers || {}),
        },
      });

    // ── TREE ────────────────────────────────────────────────────────────────
    if (action === 'tree') {
      if (path) {
        const res = await gh(`/repos/${owner}/${repoName}/contents/${path}`);
        const data = await res.json();
        if (!res.ok) return json({ error: data.message || 'Failed to list folder' }, res.status);
        const entries = Array.isArray(data) ? data.map(e => ({ name: e.name, path: e.path, type: e.type })) : [];
        return json({ entries });
      }
      let res = await gh(`/repos/${owner}/${repoName}/git/trees/main?recursive=1`);
      if (!res.ok) res = await gh(`/repos/${owner}/${repoName}/git/trees/master?recursive=1`);
      const data = await res.json();
      return json(data);
    }

    // ── GET FILE ────────────────────────────────────────────────────────────
    if (action === 'get') {
      const res = await gh(`/repos/${owner}/${repoName}/contents/${path}`);
      const data = await res.json();
      return json(data);
    }

    // ── UPLOAD / APPEND ─────────────────────────────────────────────────────
    if (action === 'upload' || action === 'append') {
      let fileSha = null;
      let finalContent = content;

      const getRes = await gh(`/repos/${owner}/${repoName}/contents/${path}`);
      if (getRes.ok) {
        const existing = await getRes.json();
        fileSha = existing.sha;
        if (action === 'append') {
          const existingText = decodeBase64(existing.content);
          finalContent = existingText + '\n\n' + content;
        }
      }

      const encoded = encodeBase64(finalContent);

      const putRes = await gh(`/repos/${owner}/${repoName}/contents/${path}`, {
        method: 'PUT',
        body: JSON.stringify({
          message: message || `${action}: ${path}`,
          content: encoded,
          ...(fileSha ? { sha: fileSha } : {}),
        }),
      });

      const putData = await putRes.json();
      if (!putRes.ok) throw new Error(putData.message || 'GitHub PUT failed');
      return json(putData);
    }

    // ── CLOUDFLARE WORKERS ───────────────────────────────────────────────────
    if (action === 'cf') {
      const { cfPath, cfOpts = {} } = body;
      if (!cfPath) return json({ error: 'No cfPath' }, 400);
      if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
        return json({ error: 'CF_ACCOUNT_ID and CF_API_TOKEN secrets not set' }, 500);
      }
      const cfBase = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}`;

      // List workers: GET /workers/scripts  → returns JSON
      // Fetch single: GET /workers/scripts/:name → returns raw JS text
      if (cfOpts.method === undefined || cfOpts.method === 'GET') {
        const isList = cfPath === '/workers/scripts';
        const res = await fetch(cfBase + cfPath, {
          headers: {
            'Authorization': `Bearer ${env.CF_API_TOKEN}`,
            'Content-Type': 'application/json',
          }
        });
        if (isList) {
          const data = await res.json();
          if (!res.ok) return json({ error: data.errors?.[0]?.message || 'CF error' }, res.status);
          return json(data);
        } else {
          const script = await res.text();
          if (!res.ok) return json({ error: 'Failed to fetch worker script' }, res.status);
          return json({ script });
        }
      }

      // Deploy / update worker: PUT /workers/scripts/:name
      if (cfOpts.method === 'PUT') {
        const script = cfOpts.script || '';

        // Detect module worker (has export/import statements)
        const isModule = /(?:^|\s|;)export(?:\s+|\{)|(?:^|\s|;)import\s+/.test(script);

        if (isModule) {
          // Module workers MUST be uploaded as multipart/form-data with metadata.
          // CRITICAL: Do NOT set Content-Type manually — let fetch generate the boundary.
          // CRITICAL: The script part MUST have a filename in Content-Disposition.
          // CRITICAL: Use application/javascript+module for module workers.
          const metadata = {
            main_module: 'index.js',
            compatibility_date: '2026-06-22',
          };

          const form = new FormData();
          form.append(
            'metadata',
            new Blob([JSON.stringify(metadata)], { type: 'application/json' })
          );
          form.append(
            'index.js',
            new Blob([script], { type: 'application/javascript+module' }),
            'index.js'
          );

          const res = await fetch(cfBase + cfPath, {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${env.CF_API_TOKEN}`,
              // NO 'Content-Type' header here — fetch sets it with the correct boundary
            },
            body: form,
          });

          const text = await res.text();
          if (!res.ok) {
            let msg = 'CF deploy failed';
            try { msg = JSON.parse(text).errors?.[0]?.message || msg; } catch (e) {}
            return json({ error: msg }, res.status);
          }
          return json({ ok: true });
        } else {
          // Classic service worker — raw JS upload
          const res = await fetch(cfBase + cfPath, {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${env.CF_API_TOKEN}`,
              'Content-Type': 'application/javascript',
            },
            body: script,
          });

          const text = await res.text();
          if (!res.ok) {
            let msg = 'CF deploy failed';
            try { msg = JSON.parse(text).errors?.[0]?.message || msg; } catch (e) {}
            return json({ error: msg }, res.status);
          }
          return json({ ok: true });
        }
      }

      return json({ error: 'Unsupported cfOpts.method' }, 400);
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// UTF-8 safe base64 encode
function encodeBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// UTF-8 safe base64 decode
function decodeBase64(b64) {
  const binary = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
