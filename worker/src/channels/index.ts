/**
 * Channel Registry — v7.0
 */

import type { ChannelPlugin } from "../plugins/types";
import { SmsChannelPlugin } from "./sms";
import { TelegramChannelPlugin } from "./telegram";
import { WhatsAppCloudChannelPlugin } from "./whatsapp-cloud";

export const BUILTIN_CHANNELS: Record<string, ChannelPlugin> = {
  sms: new SmsChannelPlugin(),
  telegram: new TelegramChannelPlugin(),
  whatsapp: new WhatsAppCloudChannelPlugin(),
};

export function getChannelPlugin(channel: string): ChannelPlugin | null {
  return BUILTIN_CHANNELS[channel.toLowerCase()] ?? null;
}
