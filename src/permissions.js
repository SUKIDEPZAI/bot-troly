import { PermissionFlagsBits } from 'discord.js';
import { config } from './config.js';

export function memberIsAdmin(member) {
  if (!member) return false;
  if (config.discord.adminUsers.has(member.id)) return true;
  if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  return member.roles?.cache?.some(r => config.discord.adminRoles.has(r.id)) || false;
}

export function memberIsModerator(member) {
  if (!member) return false;
  if (memberIsAdmin(member)) return true;
  if (member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  return member.roles?.cache?.some(r => config.discord.moderatorRoles.has(r.id)) || false;
}

export function canUseBot(message) {
  if (!message.guild) return config.discord.allowDM;
  if (config.discord.allowedGuilds.size && !config.discord.allowedGuilds.has(message.guild.id)) return false;
  if (config.discord.allowedChannels.size && !config.discord.allowedChannels.has(message.channel.id)) return false;
  if (config.discord.requireMentionForNonAdmins && !memberIsAdmin(message.member)) {
    return message.mentions.has(message.client.user);
  }
  return config.discord.replyAll || message.mentions.has(message.client.user) || memberIsAdmin(message.member);
}

export function channelPermissionReport(channel, me) {
  if (!channel?.permissionsFor || !me) return { ok:false, missing:['unknown'] };
  const perms = channel.permissionsFor(me);
  const required = [
    ['ViewChannel', PermissionFlagsBits.ViewChannel],
    ['SendMessages', PermissionFlagsBits.SendMessages],
    ['EmbedLinks', PermissionFlagsBits.EmbedLinks],
    ['AttachFiles', PermissionFlagsBits.AttachFiles],
    ['ReadMessageHistory', PermissionFlagsBits.ReadMessageHistory]
  ];
  const missing = required.filter(([, bit]) => !perms.has(bit)).map(([name]) => name);
  return { ok: missing.length === 0, missing };
}

export function mentionTarget(message) {
  const mentioned = [...message.mentions.users.values()].find(u => u.id !== message.client.user.id);
  return mentioned || null;
}
