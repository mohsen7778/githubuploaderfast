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

    // ── GITHUB TREE ─────────────────────────────────────────────────────────
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

    // ── GITHUB GET ──────────────────────────────────────────────────────────
    if (action === 'get') {
      const res = await gh(`/repos/${owner}/${repoName}/contents/${path}`);
      const data = await res.json();
      return json(data);
    }

    // ── GITHUB UPLOAD / APPEND ────────────────────────────────────────────────
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

      if (cfOpts.method === 'PUT') {
        const script = cfOpts.script || '';
        const isModule = /(?:^|\s|;)export(?:\s+|\{)|(?:^|\s|;)import\s+/.test(script);

        if (isModule) {
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

    // ═══════════════════════════════════════════════════════════════════════════
    // ── HUGGING FACE ──────────────────────────────────────────────────────────
    // ═══════════════════════════════════════════════════════════════════════════
    if (action.startsWith('hf_')) {
      const hfToken = env.HF_TOKEN;
      if (!hfToken) {
        return json({ error: 'HF_TOKEN secret not set' }, 500);
      }

      const repoId = repo;

      function encodePath(p) {
        return p.split('/').map(encodeURIComponent).join('/');
      }

      const encodedRepoId = repoId.split('/').map(encodeURIComponent).join('/');

      // Detect repo type (models, datasets, spaces)
      async function getRepoType() {
        for (const type of ['models', 'datasets', 'spaces']) {
          const res = await fetch(`https://huggingface.co/api/${type}/${encodedRepoId}`, {
            headers: {
              'Authorization': `Bearer ${hfToken}`,
              'Accept': 'application/json'
            }
          });
          if (res.ok) return type;
        }
        return null;
      }

      let repoType = await getRepoType();
      if (!repoType) {
        return json({
          error: 'HF repo not found or not accessible. Check HF_TOKEN and repo name. If using a Fine-grained token, try a Classic Write token instead.'
        }, 404);
      }

      // URL prefixes
      const resolvePrefix = repoType === 'models'
        ? `https://huggingface.co/${encodedRepoId}`
        : `https://huggingface.co/${repoType}/${encodedRepoId}`;

      const apiPrefix = `https://huggingface.co/api/${repoType}/${encodedRepoId}`;

      // ── HF TREE ─────────────────────────────────────────────────────────────
      if (action === 'hf_tree') {
        const subPath = path || '';

        async function fetchTree(treePath) {
          const suffix = treePath ? '/' + encodePath(treePath) : '';
          const url = `${apiPrefix}/tree/main${suffix}`;
          const res = await fetch(url, {
            headers: {
              'Authorization': `Bearer ${hfToken}`,
              'Accept': 'application/json'
            }
          });
          if (!res.ok) return [];
          const data = await res.json();
          return Array.isArray(data) ? data : [];
        }

        const flat = [];
        const queue = [subPath];
        const seen = new Set();

        while (queue.length) {
          const dir = queue.shift();
          if (seen.has(dir)) continue;
          seen.add(dir);

          const items = await fetchTree(dir);
          for (const item of items) {
            if (flat.some(f => f.path === item.path)) continue;
            flat.push({
              path: item.path,
              type: item.type === 'directory' ? 'tree' : 'blob'
            });
            if (item.type === 'directory') {
              queue.push(item.path);
            }
          }
        }

        return json({ tree: flat, truncated: false });
      }

      // ── HF GET ─────────────────────────────────────────────────────────────
      if (action === 'hf_get') {
        if (!path) return json({ error: 'No path specified' }, 400);

        const filePath = path;
        const url = `${resolvePrefix}/resolve/main/${encodePath(filePath)}`;

        const res = await fetch(url, {
          headers: { 'Authorization': `Bearer ${hfToken}` }
        });

        if (!res.ok) {
          const status = res.status;
          const errText = await res.text().catch(() => '');
          if (status === 401 || status === 403) {
            return json({ error: 'HF access denied. Token may lack permissions or repo is private.' }, status);
          }
          if (status === 404) {
            return json({ error: 'File not found on HF (check path and branch). Path: ' + filePath }, 404);
          }
          return json({ error: 'HF fetch failed: ' + errText }, status);
        }

        const arrayBuffer = await res.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);

        return json({ content: base64, sha: 'hf-' + filePath });
      }

      // ── HF UPLOAD / APPEND ─────────────────────────────────────────────────
      if (action === 'hf_upload' || action === 'hf_append') {
        if (!path) return json({ error: 'No path specified' }, 400);
        const filePath = path;
        let finalContent = content;

        // For append: fetch existing content first
        if (action === 'hf_append') {
          try {
            const getRes = await fetch(`${resolvePrefix}/resolve/main/${encodePath(filePath)}`, {
              headers: { 'Authorization': `Bearer ${hfToken}` }
            });
            if (getRes.ok) {
              const existing = await getRes.text();
              finalContent = existing + '\n\n' + content;
            }
          } catch (e) {
            // File might not exist, proceed with new content
          }
        }

        // NEW: Use the commit endpoint (the old /upload endpoint is retired)
        const commitUrl = `${apiPrefix}/commit/main`;

        const form = new FormData();
        const fileKey = 'file_0';

        // File operation metadata
        form.append('files', JSON.stringify([
          { key: fileKey, path: filePath, type: 'add' }
        ]));

        // Actual file content
        form.append(fileKey, new Blob([finalContent]), filePath.split('/').pop());

        // Commit message
        form.append('commit_message', message || `${action}: ${filePath}`);

        const commitRes = await fetch(commitUrl, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${hfToken}` },
          body: form,
        });

        if (!commitRes.ok) {
          const errText = await commitRes.text();
          let errMsg = 'HF commit failed';
          try {
            const errJson = JSON.parse(errText);
            errMsg = errJson.error || errJson.message || errMsg;
          } catch (e) {}
          return json({ error: errMsg }, commitRes.status);
        }

        return json({ ok: true });
      }

      return json({ error: 'Unknown HF action' }, 400);
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
