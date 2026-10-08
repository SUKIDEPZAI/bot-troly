import { csv } from './utils.js';

/** member: GuildMember (hoặc null); userId: id người dùng. Admin = quyền Administrator, ADMIN_USER_IDS hoặc ADMIN_ROLE_IDS. */
export function isAdmin({ member, userId, memberPermissions }) {
  if (csv(process.env.ADMIN_USER_IDS).includes(String(userId))) return true;
  const perms = memberPermissions ?? member?.permissions;
  if (perms?.has?.('Administrator')) return true;
  const roles = csv(process.env.ADMIN_ROLE_IDS);
  const cache = member?.roles?.cache;
  return Boolean(cache && roles.some(r => cache.has(r)));
}
export const interactionIsAdmin = i => isAdmin({ member: i.member, userId: i.user?.id, memberPermissions: i.memberPermissions });
