import { generateKeyPair } from 'jose/util/generate_key_pair';
import { exportJWK, exportPKCS8 } from 'jose';
import { randomUUID } from 'uuid';
import fs from 'fs';

const kid = process.env.KID || randomUUID();

const { publicKey, privateKey } = await generateKeyPair('RS256', { modulusLength: 2048 });
const jwk = await exportJWK(publicKey);
jwk.kty = 'RSA';
jwk.use = 'sig';
jwk.alg = 'RS256';
jwk.kid = kid;

const pkcs8 = await exportPKCS8(privateKey);
fs.writeFileSync('private.pem', pkcs8, { mode: 0o600 });

console.log('✅ Created ./private.pem (KEEP SECRET)');
console.log('\n👉 Send this JWKS to the app owner to add to their JWKS:');
console.log(JSON.stringify({ keys: [jwk] }, null, 2));
