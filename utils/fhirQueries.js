import axios from 'axios';

function buildCodeParam(codesCsv) {
  const parts = (codesCsv || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return parts.join(',');
}

/**
 * Fetch Encounters connected to Conditions with given codes, within date window.
 * 1) Try _include=Condition:encounter
 * 2) If none, follow Condition.encounter references individually
 */
export async function fetchEncountersByConditionCodes({ fhirBase, token, start, end, dateField, codesCsv }) {
  const codeParam = buildCodeParam(codesCsv);
  const params = new URLSearchParams();
  if (codeParam) params.append('code', codeParam);
  if (start) params.append(dateField, `ge${start}`);
  if (end) params.append(dateField, `le${end}`);
//   params.append('_include', 'Condition:encounter');
  params.append('_count', '100');

  let url = `${fhirBase}/Encounter?${params.toString()}`;
  console.log(url);
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/fhir+json' };
  const encs = new Map();

  // Pass 1: include
  while (url) {
    const r = await axios.get(url, { headers, timeout: 30000 });
    const b = r.data;
    (b.entry || []).forEach(e => {
      const res = e.resource;
      if (res?.resourceType === 'Encounter' && res.id) encs.set(res.id, res);
    });
    const next = (b.link || []).find(l => l.relation === 'next');
    url = next?.url || null;
  }

  // Pass 2 (fallback): follow references if none found
  if (encs.size === 0) {
    let url2 = `${fhirBase}/Condition?${params.toString()}`;
    console.log(url2);
    while (url2) {
      const r = await axios.get(url2, { headers, timeout: 30000 });
      const b = r.data;
      for (const e of b.entry || []) {
        const c = e.resource;
        if (c?.resourceType === 'Condition') {
          const ref = c?.encounter?.reference; // e.g., "Encounter/123"
          if (ref?.startsWith('Encounter/')) {
            const id = ref.split('/')[1];
            if (!encs.has(id)) {
              const er = await axios.get(`${fhirBase}/Encounter/${id}`, { headers, timeout: 15000 });
              encs.set(id, er.data);
            }
          }
        }
      }
      const next = (b.link || []).find(l => l.relation === 'next');
      url2 = next?.url || null;
    }
  }

  return Array.from(encs.values());
}

// Find Encounters within a date range (defaults to the Encounter.period date)
// start/end should be YYYY-MM-DD (or full dateTime). Example: start='2025-02-25', end='2025-02-27'
export async function fetchEncountersByDateRange({
  fhirBase,
  token,
  start,             // e.g., '2025-02-25'
  end,               // e.g., '2025-02-27'
  dateField = 'date',// Encounter search param; usually 'date' (maps to Encounter.period)
  patientId,         // optional: restrict by patient (e.g., '123' or 'Patient/123')
  status,            // optional: restrict by status (e.g., 'finished,in-progress')
  count = 100        // page size
}) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/fhir+json' };
  const encs = new Map();

  const params = new URLSearchParams();
  if (start) params.append(dateField, `ge${start}`);
  if (end)   params.append(dateField, `le${end}`);
  if (patientId) params.append('patient', patientId.startsWith('Patient/') ? patientId : `Patient/${patientId}`);
  if (status) params.append('status', status);  // comma-separated if multiple
  params.append('_count', String(count));

  let url = `${fhirBase}/Encounter?${params.toString()}`;
  console.log(url);

  while (url) {
    const r = await axios.get(url, { headers, timeout: 30000 });
    const b = r.data;
    (b.entry || []).forEach(e => {
      const res = e.resource;
      if (res?.resourceType === 'Encounter' && res.id) encs.set(res.id, res);
    });
    const next = (b.link || []).find(l => l.relation === 'next');
    url = next?.url || null;
  }

  return Array.from(encs.values());
}
