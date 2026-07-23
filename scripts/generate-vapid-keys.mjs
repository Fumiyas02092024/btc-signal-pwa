import { createECDH } from "node:crypto";

const ecdh = createECDH("prime256v1");
ecdh.generateKeys();

console.log(`VAPID_PUBLIC_KEY=${ecdh.getPublicKey().toString("base64url")}`);
console.log(`VAPID_PRIVATE_KEY=${ecdh.getPrivateKey().toString("base64url")}`);
console.log("\n上記2つを次のコマンドでCloudflare Secretsへ登録してください:");
console.log("npx wrangler secret put VAPID_PUBLIC_KEY --config worker/wrangler.jsonc");
console.log("npx wrangler secret put VAPID_PRIVATE_KEY --config worker/wrangler.jsonc");
