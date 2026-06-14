const https = require('https');

// Call Claude API with retry logic
function callClaude(apiKey, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          } else {
            resolve(parsed);
          }
        } catch(e) {
          reject(new Error('Parse error: ' + e.message + ' | raw: ' + data.slice(0, 100)));
        }
      });
    });

    req.on('error', (e) => reject(new Error('Network error: ' + e.message)));

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('TIMEOUT'));
    });

    req.write(payload);
    req.end();
  });
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const bodySize = Buffer.byteLength(event.body || '', 'utf8');
  if (bodySize > 5 * 1024 * 1024) {
    return { statusCode: 413, headers, body: JSON.stringify({ error: 'Payload too large (' + Math.round(bodySize/1024/1024*10)/10 + 'MB) — use 1-3 frames only' }) };
  }

  // Try with images first, fall back to text-only if needed
  const messagesWithImages = body.messages;
  const messagesTextOnly = body.messages.map(m => ({
    ...m,
    content: Array.isArray(m.content)
      ? m.content.filter(b => b.type === 'text').map(b => ({
          ...b,
          text: b.text + '\n\n[Note: Images unavailable — provide best estimate scores based on the metadata provided and note you are estimating without visual data]'
        }))
      : m.content
  }));

  const attempts = [
    // Attempt 1: haiku with images, 20s timeout
    { model: 'claude-haiku-4-5-20251001', messages: messagesWithImages, maxTokens: 900, timeout: 20000 },
    // Attempt 2: haiku retry with images, 22s timeout
    { model: 'claude-haiku-4-5-20251001', messages: messagesWithImages, maxTokens: 800, timeout: 22000 },
    // Attempt 3: haiku text-only fallback (much faster, no images)
    { model: 'claude-haiku-4-5-20251001', messages: messagesTextOnly, maxTokens: 700, timeout: 15000 },
  ];

  let lastError = null;

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    try {
      const payload = JSON.stringify({
        model: attempt.model,
        max_tokens: attempt.maxTokens,
        messages: attempt.messages
      });

      const result = await callClaude(apiKey, payload, attempt.timeout);
      
      // Validate we got usable content
      const text = result.content && result.content.find(b => b.type === 'text');
      if (!text || !text.text) throw new Error('Empty response from Claude');

      // Tag fallback attempts so client knows
      if (i === 2) {
        result._fallback = true;
        result._fallbackNote = 'Analysis based on metadata only — image processing unavailable. Scores are estimates.';
      }

      return { statusCode: 200, headers, body: JSON.stringify(result) };

    } catch(e) {
      lastError = e;
      console.error(`Attempt ${i+1} failed:`, e.message);
      // Brief pause between retries
      if (i < attempts.length - 1) await new Promise(r => setTimeout(r, 800));
    }
  }

  // All attempts failed — return structured error
  return {
    statusCode: 500,
    headers,
    body: JSON.stringify({ error: lastError?.message || 'All analysis attempts failed' })
  };
};
