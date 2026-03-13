import path from 'path';

/**
 * 输入 authDir（有额度目录），推导同级目录：
 * - auths_no_quota
 * - auths_invalid
 * - reports
 *
 * 约定：authDir 形如 /home/docker/CLIProxyAPI/auths
 */
export function deriveDirsFromAuthDir(authDir) {
  const quotaDir = path.resolve(authDir);
  const parent = path.dirname(quotaDir);

  // 约定：只给“有额度目录”即可自动推导：
  // - 无额度目录：<auth_dir>_no_quota
  // - 无效目录：<auth_dir>_invalid
  // - reports：与 auth_dir 同级目录下的 reports
  return {
    quotaDir,
    noQuotaDir: `${quotaDir}_no_quota`,
    invalidDir: `${quotaDir}_invalid`,
    reportDir: path.join(parent, 'reports'),
    inboxDir: `${quotaDir}_inbox`,
  };
}
