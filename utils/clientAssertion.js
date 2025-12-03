import fs from 'fs';
import { SignJWT, importPKCS8 } from 'jose';
import { v4 as uuidv4 } from 'uuid';

export async function signClientAssertion({ clientId, aud, kid, privateKeyPath }) {
  const pkcs8 = fs.readFileSync(privateKeyPath, 'utf8');
  const key = await importPKCS8(pkcs8, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    iss: clientId,
    sub: clientId,
    aud,
    jti: uuidv4(),
    iat: now,
    exp: now + 300
  })
    .setProtectedHeader({ alg: 'RS256', kid })
    .sign(key);
}