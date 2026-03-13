const KNOWN = new Set(['qwen', 'kimi', 'gemini', 'gemini-cli', 'aistudio', 'claude', 'codex', 'antigravity', 'iflow', 'vertex']);

export function detectProvider(json) {
  const direct = (json.type || json.provider || '').toString().toLowerCase().trim();
  if (KNOWN.has(direct)) return direct;
  if (json.access_token && json.account_id) return 'codex';
  if (typeof json.api_key === 'string' && json.api_key.startsWith('AIza')) return 'gemini';
  if (typeof json.api_key === 'string' && json.api_key.startsWith('sk-ant-')) return 'claude';
  if (json.project_id && json.private_key && json.client_email) return 'vertex';
  if (json.refresh_token && (json.client_id || json.account_id)) return 'qwen';
  if (json.api_key || json.access_token || json.refresh_token) return 'unknown-token-style';
  return 'unknown';
}

function hasAny(json, ...keys) {
  return keys.some((k) => {
    const v = json[k];
    return typeof v === 'string' ? v.trim().length > 0 : Boolean(v);
  });
}

export function schemaValid(provider, json) {
  switch (provider) {
    case 'codex':
      return hasAny(json, 'access_token') && hasAny(json, 'account_id');
    case 'gemini':
    case 'gemini-cli':
    case 'aistudio':
      return hasAny(json, 'api_key', 'access_token');
    case 'claude':
      return hasAny(json, 'api_key', 'x_api_key', 'access_token');
    case 'vertex':
      return hasAny(json, 'project_id') && hasAny(json, 'private_key', 'access_token');
    case 'qwen':
    case 'kimi':
    case 'iflow':
    case 'antigravity':
      return hasAny(json, 'access_token', 'api_key', 'refresh_token');
    default:
      return hasAny(json, 'access_token', 'api_key', 'refresh_token');
  }
}

export function validateSchemaWithReason(provider, json) {
  switch (provider) {
    case 'codex':
      return schemaValid(provider, json)
        ? { ok: true }
        : { ok: false, reason: 'codex_missing_required_fields' };
    case 'gemini':
    case 'gemini-cli':
    case 'aistudio':
      return schemaValid(provider, json)
        ? { ok: true }
        : { ok: false, reason: `${provider}_missing_required_fields` };
    case 'claude':
      return schemaValid(provider, json)
        ? { ok: true }
        : { ok: false, reason: 'claude_missing_required_fields' };
    case 'vertex':
      return schemaValid(provider, json)
        ? { ok: true }
        : { ok: false, reason: 'vertex_missing_required_fields' };
    case 'qwen':
    case 'kimi':
    case 'iflow':
    case 'antigravity':
      return schemaValid(provider, json)
        ? { ok: true }
        : { ok: false, reason: `${provider}_missing_required_fields` };
    default:
      return schemaValid(provider, json)
        ? { ok: true, schemaOnly: true }
        : { ok: false, reason: 'unknown_provider_missing_required_fields' };
  }
}
