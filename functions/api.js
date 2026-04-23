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

    if (!repo) return json({ error: 'No repo specified' }, 400);
    const [owner, repoName] = repo.split('/');

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
