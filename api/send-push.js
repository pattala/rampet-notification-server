// /api/send-push.js — Envío PUSH por templateId a 1/varios/segmento
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getMessaging } from 'firebase-admin/messaging';
import { resolveTemplate, sanitizePush, applyBlocksAndVars } from '../utils/templates.js';

if (!getApps().length) {
  const creds = process.env.GOOGLE_CREDENTIALS_JSON ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON) : null;
  initializeApp(creds ? { credential: cert(creds) } : {});
}
const db = getFirestore();
const adminAuth = getAuth();
const fcm = getMessaging();

const allowOrigins = String(process.env.CORS_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

function setCORS(res, origin) {
  if (!origin) return;
  const ok = allowOrigins.length === 0 || allowOrigins.includes(origin);
  if (ok) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-secret');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  setCORS(res, origin);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method not allowed' });

  try {
    const apiSecret = req.headers['x-api-secret'];
    if (!apiSecret || apiSecret !== process.env.API_SECRET_KEY) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const idToken = (req.headers.authorization || '').replace('Bearer ', '');
    let requestedBy = null;
    if (idToken) {
      try {
        const decoded = await adminAuth.verifyIdToken(idToken);
        if (!decoded.role || !['admin', 'superadmin'].includes(decoded.role)) {
          return res.status(403).json({ ok: false, error: 'forbidden' });
        }
        requestedBy = { uid: decoded.uid, role: decoded.role, email: decoded.email || null };
      } catch (e) {
        return res.status(401).json({ ok: false, error: 'invalid token' });
      }
    }

    const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    const { templateId, segment = {}, options = {}, defaults = {}, overrideVars = {} } = body;
    const { dryRun = false, saveInbox = true, batchSize = 500, maxPerSecond = 200 } = options;

    if (!templateId) return res.status(400).json({ ok:false, error:'templateId required' });

    const tpl = await resolveTemplate(db, templateId, 'push');
    const recipients = await getRecipients(db, segment);
    const jobId = new Date().toISOString().replace(/[:.]/g,'-')+`-${templateId}`;

    const summary = { total: recipients.length, push: 0, skipped: 0 };
    const invalidTokens = new Set();

    const chunks = chunkArray(recipients, batchSize);
    for (const chunk of chunks) {
      const t0 = Date.now();
      for (const r of chunk) {
        const data = buildDataFor(r, defaults, overrideVars);
        const titulo = applyBlocksAndVars(tpl.titulo, data);
        const cuerpo = sanitizePush(applyBlocksAndVars(tpl.cuerpo, data));

        if (!r.tokens || !r.tokens.length) { summary.skipped++; continue; }

        if (!dryRun) {
          try {
            const resp = await fcm.sendEachForMulticast({
              tokens: r.tokens,
              notification: { title: titulo, body: cuerpo },
              data: { templateId, uid: r.uid }
            });
            resp.responses.forEach((it, idx) => {
              if (!it.success) {
                const err = String(it.error && it.error.code || '');
                if (err.includes('registration-token-not-registered')) {
                  invalidTokens.add(r.tokens[idx]);
                }
              }
            });
            summary.push = (summary.push || 0) + resp.successCount;
          } catch (e) {}
        }

        if (saveInbox && !dryRun) {
          await db.collection('clientes').doc(r.uid)
            .collection('inbox').add({
              ts: Date.now(), tipo: 'push', templateId, titulo, cuerpo,
              meta: { jobId, requestedBy }
            });
        }

        await db.collection('envios').doc(jobId)
          .collection('items').doc(r.uid)
          .set({
            uid: r.uid, email: r.email || null, tokens: (r.tokens||[]).length,
            channel: 'push', templateId, varsUsadas: data,
            status: dryRun ? 'dry-run' : 'sent', ts: Date.now()
          }, { merge: true });
      }
      const elapsed = Date.now() - t0;
      const target = Math.ceil((chunk.length / maxPerSecond) * 1000);
      if (elapsed < target) await new Promise(r => setTimeout(r, target - elapsed));
    }

    if (invalidTokens.size && !dryRun) {
      await pruneInvalidTokens(db, Array.from(invalidTokens));
    }

    await db.collection('envios').doc(jobId).set({
      channel: 'push', templateId, segment, options, requestedBy, summary, createdAt: Date.now()
    }, { merge: true });

    return res.status(200).json({ ok: true, jobId, counts: summary, dryRun });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message || 'unknown error' });
  }
}

function chunkArray(arr, size){
  const out = []; for (let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size)); return out;
}

function buildDataFor(r, defaults = {}, overrides = {}) {
  const base = {
    uid: r.uid, nombre: r.nombre || '', email: r.email || '', numeroSocio: r.numeroSocio || '',
    puntos: r.puntos || 0, pwa_url: defaults.pwa_url || '', link_terminos: defaults.link_terminos || ''
  };
  return Object.assign(base, r.vars || {}, overrides);
}

async function getRecipients(db, segment) {
  const s = segment || {}; const out = [];
  if (s.type === 'one' && s.uid) {
    const d = await db.collection('clientes').doc(s.uid).get();
    if (d.exists) out.push(packRecipient(d));
  } else if (s.type === 'uids' && Array.isArray(s.uids)) {
    const chunks = chunkArray(s.uids, 10);
    for (const ch of chunks) {
      const snaps = await db.collection('clientes').where('__name__','in', ch).get();
      snaps.forEach(doc => out.push(packRecipient(doc)));
    }
  } else if (s.type === 'query') {
    let q = db.collection('clientes');
    if (s.esTester === true) q = q.where('esTester','==', true);
    if (s.barrio) q = q.where('domicilio.barrio','==', s.barrio);
    if (s.partido) q = q.where('domicilio.partido','==', s.partido);
    const snap = await q.limit(1000).get();
    snap.forEach(doc => out.push(packRecipient(doc)));
  }
  return out;
}

function packRecipient(doc) {
  const d = doc.data() || {}; const tokens = Array.isArray(d.fcmTokens) ? d.fcmTokens.filter(Boolean) : [];
  return {
    uid: doc.id, email: d.email || null, nombre: d.nombre || null, numeroSocio: d.numeroSocio || null,
    puntos: d.puntos || 0, tokens
  };
}

async function pruneInvalidTokens(db, tokens) {
  if (!tokens.length) return;
  const slice = tokens.slice(0, 10);
  const snap = await db.collection('clientes').where('fcmTokens','array-contains-any', slice).get();
  const batch = db.batch();
  snap.forEach(doc => {
    const arr = (doc.data().fcmTokens||[]).filter(t => !slice.includes(t));
    batch.update(doc.ref, { fcmTokens: arr });
  });
  await batch.commit();
}
