// scripts/ecr_flow_node.js
import 'dotenv/config.js';
import axios from 'axios';
import { signClientAssertion } from '../utils/clientAssertion.js';
import { fetchEncountersByConditionCodes, fetchEncountersByDateRange } from '../utils/fhirQueries.js';
import { fetchEncountersByConditionCodesPost } from '../utils/fhirQueriesPost.js';

// If you already had submitEncounter or other imports, keep them as is.

const CFG = {
  // === FHIR OAuth ===
  AUTH_MODE: (process.env.AUTH_MODE || 'SOF_BACKEND').toUpperCase(), // NEW default covers “client id only”
  CLIENT_ID: process.env.CLIENT_ID,
  CLIENT_SECRET: process.env.CLIENT_SECRET,          // optional for client_secret_* modes
  TOKEN_URL: process.env.TOKEN_URL,
  SCOPE: process.env.SCOPE || 'system/*.read',
  KID: process.env.KID,                               // key id registered with EHR
  PRIVATE_KEY_PATH: process.env.PRIVATE_KEY_PATH,     // path to PEM private key
  REQUIRE_AUD: String(process.env.REQUIRE_AUD || 'true').toLowerCase() === 'true',
  AUD: process.env.AUD,                               // override audience (defaults to TOKEN_URL)

  // === FHIR server / search params ===
  FHIR_BASE: process.env.FHIR_BASE,
  START_DATE: process.env.START_DATE,
  END_DATE: process.env.END_DATE,
  DATE_FIELD: process.env.DATE_FIELD || 'recorded-date',
  CODES_CSV: process.env.CANCER_CODES || process.env.CODES_CSV || '', // reuse your code list
  USE_POST_SEARCH: String(process.env.USE_POST_SEARCH || 'false').toLowerCase() === 'true',

  // === eCRNow auth & API ===
  ECRNOW_TOKEN_URL: process.env.ECRNOW_TOKEN_URL,
  ECRNOW_CLIENT_ID: process.env.ECRNOW_CLIENT_ID,
  ECRNOW_CLIENT_SECRET: process.env.ECRNOW_CLIENT_SECRET,
  ECRNOW_USER_ID: process.env.ECRNOW_USER_ID,         // if your realm expects it
  ECRNOW_API_BASE: process.env.ECRNOW_API_BASE || 'http://localhost:8081',

  // === Flow selector ===
  FLOW_MODE: (process.env.FLOW_MODE || 'notify').toLowerCase(), // "notify" (existing) or "launch" (new)

  // === launchPatient toggles ===
  VALIDATION_MODE: String(process.env.VALIDATION_MODE || 'false'),
  THROTTLE_CONTEXT: String(process.env.THROTTLE_CONTEXT || '1'),

  // (keep any other existing vars you already use in the file)
};

// ---------- helpers ----------
function need(obj, keys) {
  const miss = keys.filter(k => !obj[k] || String(obj[k]).trim() === '');
  if (miss.length) throw new Error(`Missing env: ${miss.join(', ')}`);
}

function getPatientIdFromEncounter(enc) {
  const ref = enc?.subject?.reference || ''; // e.g. "Patient/56089"
  if (ref.startsWith('Patient/')) return ref.split('/')[1];
  return null;
}

// ---------- OAuth: FHIR (adds SOF_BACKEND) ----------
async function getFhirToken() {
  need(CFG, ['TOKEN_URL', 'CLIENT_ID', 'FHIR_BASE']);

  const mode = CFG.AUTH_MODE; // SOF_BACKEND | PRIVATE_KEY_JWT | CLIENT_SECRET_BASIC | CLIENT_SECRET_POST
  const headers = { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' };
  const form = new URLSearchParams();
  form.append('grant_type', 'client_credentials');
  if (CFG.SCOPE) form.append('scope', CFG.SCOPE);

  // Audience
  const aud = CFG.AUD || CFG.TOKEN_URL;
  const addAud = CFG.REQUIRE_AUD && aud;

  switch (mode) {
    case 'SOF_BACKEND': // SMART Backend Services (private_key_jwt with no client_secret)
    case 'PRIVATE_KEY_JWT': {
      need(CFG, ['KID', 'PRIVATE_KEY_PATH']);
      const clientAssertion = await signClientAssertion({
        clientId: CFG.CLIENT_ID,
        aud,
        kid: CFG.KID,
        privateKeyPath: CFG.PRIVATE_KEY_PATH,
      });
      form.append('client_id', CFG.CLIENT_ID);
      form.append('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
      form.append('client_assertion', clientAssertion);
      if (addAud) form.append('aud', aud);
      break;
    }
    case 'CLIENT_SECRET_BASIC': {
      need(CFG, ['CLIENT_SECRET']);
      const basic = Buffer.from(`${CFG.CLIENT_ID}:${CFG.CLIENT_SECRET}`).toString('base64');
      headers.Authorization = `Basic ${basic}`;
      if (addAud) form.append('aud', aud);
      break;
    }
    case 'CLIENT_SECRET_POST': {
      need(CFG, ['CLIENT_SECRET']);
      form.append('client_id', CFG.CLIENT_ID);
      form.append('client_secret', CFG.CLIENT_SECRET);
      if (addAud) form.append('aud', aud);
      break;
    }
    default:
      throw new Error(`Unsupported AUTH_MODE: ${mode}`);
  }

  const resp = await axios.post(CFG.TOKEN_URL, form.toString(), { headers, timeout: 25000 });
  if (!resp.data?.access_token) {
    throw new Error(`FHIR token endpoint did not return access_token. Body: ${JSON.stringify(resp.data)}`);
  }
  return resp.data.access_token;
}

// ---------- OAuth: eCRNow ----------
async function getEcrToken() {
  need(CFG, ['ECRNOW_TOKEN_URL', 'ECRNOW_CLIENT_ID']);
  const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: CFG.ECRNOW_CLIENT_ID });
  if (CFG.ECRNOW_CLIENT_SECRET) form.append('client_secret', CFG.ECRNOW_CLIENT_SECRET);
  if (CFG.ECRNOW_USER_ID) form.append('userId', CFG.ECRNOW_USER_ID);

  const r = await axios.post(CFG.ECRNOW_TOKEN_URL, form.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 20000
  });
  return r.data?.access_token;
}

// ---------- FLOW: launchPatient (new) ----------
async function runLaunchFlow() {
  console.log('🔑 Getting FHIR token (', CFG.AUTH_MODE, ')…');
  const fhirToken = await getFhirToken();
  console.log('FHIR token OK.');

  console.log('🔒 Getting eCRNow access token…');
  const ecrBearer = await getEcrToken();
  need({ ecrBearer }, ['ecrBearer']);
  console.log('eCRNow token OK.');

  need(CFG, ['FHIR_BASE', 'ECRNOW_API_BASE']);

  // Fetch encounters using your existing helpers
  // const fetcher = CFG.USE_POST_SEARCH ? fetchEncountersByConditionCodesPost : fetchEncountersByConditionCodes;
  console.log(`🔎 Querying FHIR for Encounters (USE_POST_SEARCH=${CFG.USE_POST_SEARCH})…`);
  const encounters = await fetchEncountersByDateRange({
    fhirBase: CFG.FHIR_BASE,
    token: fhirToken,
    start: CFG.START_DATE,
    end: CFG.END_DATE,
    dateField: CFG.DATE_FIELD
  });

  console.log(`Found ${encounters.length} Encounter(s).`);
  const url = `${CFG.ECRNOW_API_BASE}/api/launchPatient`;

  for (const enc of encounters) {
    const encounterId = enc?.id;
    const patientId = getPatientIdFromEncounter(enc);
    if (!encounterId || !patientId) {
      console.warn(`⚠️  Skipping encounter with missing ids (encounterId=${encounterId}, patientId=${patientId})`);
      continue;
    }

    const body = {
      fhirServerURL: CFG.FHIR_BASE,
      patientId,
      encounterId,
      validationMode: CFG.VALIDATION_MODE,
      throttleContext: CFG.THROTTLE_CONTEXT
    };

    console.log(`➡️  POST ${url}  (Encounter/${encounterId}, Patient/${patientId})`);
    try {
      const resp = await axios.post(url, body, {
          headers: {
              'Content-Type': 'application/json', Authorization: `Bearer ${ecrBearer}`, 'X-Request-ID': crypto.randomUUID(),
              'X-Correlation-ID': crypto.randomUUID()
          },
        timeout: 60000
      });
      console.log(`✅ launchPatient OK for Encounter/${encounterId}:`, JSON.stringify(resp.data, null, 2));
    } catch (e) {
      console.error(`❌ launchPatient failed for Encounter/${encounterId}:`, e.response?.status, JSON.stringify(e.response?.data, 0, 1) || e.message);
    }
  }
}


async function runNotifyFlow() {
  // Use this placeholder to write code for receive-notification flow.
  console.log('FLOW_MODE=notify — running notification flow…');
  // ...
}

// ---------- main ----------
(async () => {
  try {
    if (CFG.FLOW_MODE === 'launch') {
      await runLaunchFlow();
    } else {
      await runNotifyFlow();
    }
    console.log('🎉 Done.');
  } catch (e) {
    console.error('Fatal:', e.response?.data || e.message);
    process.exit(1);
  }
})();
