import { connection } from "next/server";
import VoiceBot from "@/components/VoiceBot";

export default async function Home() {
  // Dynamic rendering is required so every response gets a fresh CSP nonce.
  await connection();
  return <VoiceBot />;
}
