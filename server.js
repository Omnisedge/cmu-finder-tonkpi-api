require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "15mb" }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- Helpers métier ---
function normaliserTexte(str) {
  if (!str) return "";
  return str
    .toString()
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normaliserAgence(str) {
  const norm = normaliserTexte(str);
  if (!norm) return "";
  if (norm === "BK" || norm === "BIANKOUMA") return "BIANKOUMA";
  if (norm === "DAN" || norm === "DANANE") return "DANANE";
  if (norm === "MAN") return "MAN";
  if (norm === "SIP" || norm === "SIPILOU") return "SIPILOU";
  if (
    norm === "ZH" ||
    norm === "ZOUAN-HOUNIEN" ||
    norm === "ZOUAN HOUNIEN" ||
    norm === "ZOUAN-HOUN"
  ) {
    return "ZOUAN-HOUNIEN";
  }
  if (norm === "REGIONAL" || norm === "TONKPI" || norm === "SUP" || norm === "CE") {
    return "REGIONAL";
  }
  return norm;
}

function normaliserSousPrefecture(str) {
  const base = normaliserTexte(str || "");
  if (!base) return "";
  return base
    .replace(/\b(SOUS-PREFECTURE|SOUS PREFECTURE|S\/P|SP)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formaterTelephone10(tel) {
  if (tel === null || tel === undefined) return "";
  let chiffres = tel.toString().replace(/\D/g, "");
  if (!chiffres) return "";
  if (chiffres.length === 9) chiffres = "0" + chiffres;
  return chiffres;
}

function nettoyerTelephoneWhatsapp(tel) {
  const dix = formaterTelephone10(tel);
  if (!dix) return "";
  if (dix.length === 10) return "225" + dix;
  return dix;
}

function formaterNumSecu(numSecu, numeroSecours) {
  const val =
    numSecu !== null && numSecu !== undefined && numSecu.toString().trim() !== ""
      ? numSecu.toString().trim()
      : numeroSecours !== null && numeroSecours !== undefined
      ? numeroSecours.toString().trim()
      : "";
  return val || "Non renseigné";
}

function formaterDateFR(val) {
  if (!val) return "";
  if (val instanceof Date && !isNaN(val.getTime())) {
    const j = String(val.getDate()).padStart(2, "0");
    const m = String(val.getMonth() + 1).padStart(2, "0");
    const a = val.getFullYear();
    return `${j}/${m}/${a}`;
  }
  return val.toString().trim();
}

function extraireAgenceDemandeur(statutStr) {
  if (!statutStr) return "";
  const up = normaliserTexte(statutStr);
  const depts = ["ZOUAN-HOUNIEN", "BIANKOUMA", "DANANE", "SIPILOU", "MAN", "ZH", "BK", "DAN", "SIP"];
  for (let i = 0; i < depts.length; i++) {
    const idx = up.indexOf("VERS " + depts[i]);
    if (idx !== -1) {
      return normaliserAgence(depts[i]);
    }
  }
  const matchVers = up.match(/\bVERS\s+([A-Z0-9-]+(?:\s+HOUNIEN)?)/);
  if (matchVers && matchVers[1]) {
    const cand = normaliserAgence(matchVers[1].trim());
    if (cand && cand !== "REGIONAL") return cand;
  }
  for (let j = 0; j < depts.length; j++) {
    if (up.indexOf(depts[j]) !== -1) {
      return normaliserAgence(depts[j]);
    }
  }
  return "";
}

async function trouverContactWhatsappAgence(agenceCible) {
  const cibleNorm = normaliserAgence(agenceCible);
  const res = await pool.query(
    `SELECT "AGENCE", "NUMERO" FROM utilisateurs WHERE "NUMERO" IS NOT NULL AND TRIM("NUMERO") <> ''`
  );
  for (const row of res.rows) {
    if (normaliserAgence(row.AGENCE) === cibleNorm) {
      const wa = nettoyerTelephoneWhatsapp(row.NUMERO);
      if (wa) return wa;
    }
  }
  return "";
}

function estSuperviseurOuCe(role, agence) {
  const roleNorm = normaliserTexte(role || "");
  const agenceNorm = normaliserAgence(agence || "");
  return (
    roleNorm === "SUPERVISEUR" ||
    roleNorm === "PATRON" ||
    roleNorm === "CHEF D'EQUIPE" ||
    roleNorm === "CHEF_EQUIPE" ||
    roleNorm === "CHEF EQUIPE" ||
    roleNorm === "SUP" ||
    roleNorm === "CE" ||
    agenceNorm === "REGIONAL"
  );
}

function echapperCsv(val) {
  const s = val === null || val === undefined ? "" : String(val);
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// --- Route de santé ---
app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "CMU FINDER TONKPI API", version: "3.6-CONTIENT-AGENCE-SP" });
});

// --- 1. Connexion ---
app.post("/api/login", async (req, res) => {
  try {
    const idRecherche = req.body.identifiant ? normaliserTexte(req.body.identifiant) : "";
    const passRecherche = req.body.password ? req.body.password.toString().trim() : "";

    if (!idRecherche || !passRecherche) {
      return res.json({
        success: false,
        suspendu: false,
        message: "Veuillez saisir votre identifiant et votre mot de passe."
      });
    }

    const q = await pool.query(
      `SELECT id, "AGENCE", "NOM_PRENOMS", "IDENTIFIANT", "MOT_DE_PASSE", "ROLE", "NUMERO", "TENTATIVES_SUSPENSION"
       FROM utilisateurs
       WHERE UPPER(TRIM("IDENTIFIANT")) = $1
       LIMIT 1`,
      [idRecherche]
    );

    if (q.rows.length === 0) {
      return res.json({
        success: false,
        suspendu: false,
        message: `Identifiant '${req.body.identifiant.trim()}' introuvable dans UTILISATEURS.`
      });
    }

    const user = q.rows[0];
    const etatSecu = (user.TENTATIVES_SUSPENSION || "").toString().trim();
    const dbAgence = normaliserAgence(user.AGENCE) || (user.AGENCE || "").toString().trim();
    const dbNom = (user.NOM_PRENOMS || "").toString().trim();
    const dbPass = (user.MOT_DE_PASSE || "").toString().trim();
    const dbRole = user.ROLE ? normaliserTexte(user.ROLE) : "AGENT";

    if (dbPass === passRecherche) {
      if (etatSecu !== "") {
        await pool.query(`UPDATE utilisateurs SET "TENTATIVES_SUSPENSION" = '' WHERE id = $1`, [user.id]);
      }
      const agenceEffective = dbAgence || normaliserAgence(user.IDENTIFIANT);
      return res.json({
        success: true,
        identifiant: (user.IDENTIFIANT || idRecherche).toString().trim().toUpperCase(),
        nomComplet: dbNom || user.IDENTIFIANT,
        agence: agenceEffective,
        agenceNorm: normaliserAgence(agenceEffective),
        role: dbRole,
        whatsapp: formaterTelephone10(user.NUMERO)
      });
    }

    return res.json({
      success: false,
      suspendu: false,
      message: "Identifiant ou mot de passe incorrect."
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Erreur serveur : " + err.message });
  }
});

// --- 1b. Création d'un nouvel accès (SUP et CE) ---
app.post("/api/comptes/creer", async (req, res) => {
  try {
    const demandeurRoleNorm = normaliserTexte(req.body.demandeurRole || "");
    const demandeurAgenceNorm = normaliserAgence(req.body.demandeurAgence || "");
    const demandeurIdNorm = normaliserTexte(req.body.demandeurId || "");

    if (!estSuperviseurOuCe(demandeurRoleNorm, demandeurAgenceNorm)) {
      return res.status(403).json({
        success: false,
        message: "Accès réservé aux profils SUP et CE."
      });
    }

    const idNouveau = normaliserTexte(req.body.identifiant || "");
    const nomPrenoms = (req.body.nomComplet || req.body.nom_prenoms || "").toString().trim();
    const roleCible = normaliserTexte(req.body.role || "AGENT") || "AGENT";
    const agenceCible = normaliserAgence(req.body.agence || demandeurAgenceNorm || "MAN") || "MAN";
    const localiteCible =
      normaliserTexte(req.body.localite || req.body.sous_prefecture || agenceCible || "");
    const motDePasse = (req.body.password || "").toString().trim();
    const numeroTel = formaterTelephone10(req.body.numero || "");

    if (!idNouveau || !nomPrenoms || !motDePasse || motDePasse.length < 4) {
      return res.status(400).json({
        success: false,
        message: "Identifiant, nom/prénoms et mot de passe (4 caractères minimum) sont obligatoires."
      });
    }

    const existant = await pool.query(
      `SELECT id FROM utilisateurs WHERE UPPER(TRIM("IDENTIFIANT")) = $1 LIMIT 1`,
      [idNouveau]
    );
    if (existant.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: `L'identifiant '${idNouveau}' existe déjà.`
      });
    }

    let compte = null;
    try {
      const insAvecLoc = await pool.query(
        `INSERT INTO utilisateurs ("AGENCE", "LOCALITE", "NOM_PRENOMS", "IDENTIFIANT", "MOT_DE_PASSE", "ROLE", "NUMERO", "TENTATIVES_SUSPENSION")
         VALUES ($1, $2, $3, $4, $5, $6, $7, '')
         RETURNING id, "AGENCE", "LOCALITE", "NOM_PRENOMS", "IDENTIFIANT", "MOT_DE_PASSE", "ROLE", "NUMERO"`,
        [agenceCible, localiteCible, nomPrenoms, idNouveau, motDePasse, roleCible, numeroTel]
      );
      const r = insAvecLoc.rows[0];
      compte = {
        id: r.id,
        agence: r.AGENCE,
        localite: r.LOCALITE || localiteCible,
        nom_prenoms: r.NOM_PRENOMS,
        identifiant: r.IDENTIFIANT,
        mot_de_passe: r.MOT_DE_PASSE,
        role: r.ROLE,
        numero: r.NUMERO
      };
    } catch (e) {
      const insSansLoc = await pool.query(
        `INSERT INTO utilisateurs ("AGENCE", "NOM_PRENOMS", "IDENTIFIANT", "MOT_DE_PASSE", "ROLE", "NUMERO", "TENTATIVES_SUSPENSION")
         VALUES ($1, $2, $3, $4, $5, $6, '')
         RETURNING id, "AGENCE", "NOM_PRENOMS", "IDENTIFIANT", "MOT_DE_PASSE", "ROLE", "NUMERO"`,
        [agenceCible, nomPrenoms, idNouveau, motDePasse, roleCible, numeroTel]
      );
      const r = insSansLoc.rows[0];
      compte = {
        id: r.id,
        agence: r.AGENCE,
        localite: localiteCible,
        nom_prenoms: r.NOM_PRENOMS,
        identifiant: r.IDENTIFIANT,
        mot_de_passe: r.MOT_DE_PASSE,
        role: r.ROLE,
        numero: r.NUMERO
      };
    }

    return res.status(201).json({
      success: true,
      message: `Accès créé pour ${compte.identifiant} (${compte.role} • ${compte.agence} • ${compte.localite || agenceCible}) par ${demandeurIdNorm || demandeurRoleNorm}.`,
      compte: compte
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Erreur serveur lors de la création de l'accès : " + err.message
    });
  }
});

// --- 1c. Changement de mot de passe (SUP et CE) ---
app.post("/api/comptes/mot-de-passe", async (req, res) => {
  try {
    const demandeurRoleNorm = normaliserTexte(req.body.demandeurRole || "");
    const demandeurAgenceNorm = normaliserAgence(req.body.demandeurAgence || "");
    const demandeurIdNorm = normaliserTexte(req.body.demandeurId || "");

    if (!estSuperviseurOuCe(demandeurRoleNorm, demandeurAgenceNorm)) {
      return res.status(403).json({
        success: false,
        message: "Accès réservé aux profils SUP et CE."
      });
    }

    const idCible = normaliserTexte(req.body.identifiantCible || "");
    const nouveauMotDePasse = (req.body.nouveauMotDePasse || "").toString().trim();

    if (!idCible || !nouveauMotDePasse || nouveauMotDePasse.length < 4) {
      return res.status(400).json({
        success: false,
        message: "Identifiant cible et nouveau mot de passe (4 caractères minimum) sont obligatoires."
      });
    }

    const q = await pool.query(
      `SELECT id, "IDENTIFIANT", "ROLE", "AGENCE" FROM utilisateurs WHERE UPPER(TRIM("IDENTIFIANT")) = $1 LIMIT 1`,
      [idCible]
    );
    if (q.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Compte '${idCible}' introuvable.`
      });
    }

    const cible = q.rows[0];
    await pool.query(
      `UPDATE utilisateurs SET "MOT_DE_PASSE" = $1, "TENTATIVES_SUSPENSION" = '' WHERE id = $2`,
      [nouveauMotDePasse, cible.id]
    );

    return res.json({
      success: true,
      message: `Mot de passe mis à jour pour ${cible.IDENTIFIANT} (modifié par ${demandeurIdNorm || demandeurRoleNorm}).`
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Erreur serveur lors du changement de mot de passe : " + err.message
    });
  }
});

// --- 1d. Liste des comptes avec mot de passe et localité (SUP et CE) ---
app.get("/api/comptes", async (req, res) => {
  try {
    const demandeurRoleNorm = normaliserTexte(req.query.role || "");
    const demandeurAgenceNorm = normaliserAgence(req.query.agence || "");

    if (!estSuperviseurOuCe(demandeurRoleNorm, demandeurAgenceNorm)) {
      return res.status(403).json({
        success: false,
        message: "Accès réservé aux profils SUP et CE."
      });
    }

    let rows = [];
    try {
      const qAvecLoc = await pool.query(
        `SELECT id, "AGENCE", "LOCALITE", "NOM_PRENOMS", "IDENTIFIANT", "MOT_DE_PASSE", "ROLE", "NUMERO", "TENTATIVES_SUSPENSION"
         FROM utilisateurs
         ORDER BY id DESC`
      );
      rows = qAvecLoc.rows;
    } catch (e) {
      const qSansLoc = await pool.query(
        `SELECT id, "AGENCE", "NOM_PRENOMS", "IDENTIFIANT", "MOT_DE_PASSE", "ROLE", "NUMERO", "TENTATIVES_SUSPENSION"
         FROM utilisateurs
         ORDER BY id DESC`
      );
      rows = qSansLoc.rows;
    }

    const comptes = rows.map((u) => {
      const ag = normaliserAgence(u.AGENCE) || (u.AGENCE || "").toString().trim();
      const loc = normaliserTexte(u.LOCALITE || "");
      return {
        id: u.id,
        agence: ag,
        localite: loc || ag || "-",
        nomPrenoms: (u.NOM_PRENOMS || "").toString().trim(),
        identifiant: (u.IDENTIFIANT || "").toString().trim(),
        motDePasse: (u.MOT_DE_PASSE || "").toString().trim(),
        role: (u.ROLE || "AGENT").toString().trim(),
        numero: formaterTelephone10(u.NUMERO),
        etatSecu: (u.TENTATIVES_SUSPENSION || "").toString().trim()
      };
    });

    return res.json({ success: true, comptes });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Erreur serveur lors du chargement des accès : " + err.message
    });
  }
});

// --- 2. Recherche rapide ---
app.get("/api/cartes/recherche", async (req, res) => {
  try {
    const raw = (req.query.q || "").toString().trim();
    const terme = raw.toLowerCase();
    if (terme.length < 2) return res.json([]);

    const limite = 60;
    const likeTerm = `%${terme}%`;

    const exactRes = await pool.query(
      `SELECT id, "RANGEMENT", "NUM_SECU", "NOM", "PRENOMS", "DATE_NAISSANCE", "NUMERO", "AGENCE", "SOUS-PREFECTURE", "LIEU_PRECIS", "STATUT_TRANSFERT"
       FROM cartes
       WHERE LOWER(TRIM(COALESCE("NUM_SECU", ''))) = $1
          OR LOWER(TRIM(COALESCE("NUMERO", ''))) = $1
       LIMIT $2`,
      [terme, limite]
    );

    let rowsCartes = exactRes.rows;

    if (rowsCartes.length < limite) {
      const existingIds = rowsCartes.map((r) => r.id);
      const partRes = await pool.query(
        `SELECT id, "RANGEMENT", "NUM_SECU", "NOM", "PRENOMS", "DATE_NAISSANCE", "NUMERO", "AGENCE", "SOUS-PREFECTURE", "LIEU_PRECIS", "STATUT_TRANSFERT"
         FROM cartes
         WHERE (
           LOWER(COALESCE("NOM", '')) LIKE $1
           OR LOWER(COALESCE("PRENOMS", '')) LIKE $1
           OR LOWER(COALESCE("NOM", '') || ' ' || COALESCE("PRENOMS", '')) LIKE $1
           OR LOWER(COALESCE("NUM_SECU", '')) LIKE $1
           OR LOWER(COALESCE("NUMERO", '')) LIKE $1
         )
         AND NOT (id = ANY($2::int[]))
         LIMIT $3`,
        [likeTerm, existingIds.length ? existingIds : [0], limite - rowsCartes.length]
      );
      rowsCartes = rowsCartes.concat(partRes.rows);
    }

    const formattedActives = rowsCartes.map((r) => {
      const agence = normaliserAgence(r.AGENCE) || (r.AGENCE || "Non définie").toString().trim();
      const sousPref = normaliserTexte(r["SOUS-PREFECTURE"] || "");
      const lieu = (r.LIEU_PRECIS || sousPref || "Non défini").toString().trim();
      return {
        ligneIndex: r.id,
        rangement: (r.RANGEMENT || "Non défini").toString().trim(),
        numSecu: formaterNumSecu(r.NUM_SECU, r.NUMERO),
        nom: (r.NOM || "").toString().trim(),
        prenoms: (r.PRENOMS || "").toString().trim(),
        dateNaissance: formaterDateFR(r.DATE_NAISSANCE),
        agence,
        agenceNorm: normaliserAgence(agence),
        sousPrefecture: sousPref,
        lieuPrecis: lieu,
        statut: (r.STATUT_TRANSFERT || "DISPONIBLE").toString().trim(),
        estRetiree: false
      };
    });

    const resteLimite = Math.max(10, limite - formattedActives.length);
    const histRes = await pool.query(
      `SELECT id, "RANGEMENT", "NUM_SECU", "NOM", "PRENOMS", "DATE_NAISSANCE", "NUMERO", "AGENCE", "SOUS-PREFECTURE", "LIEU_PRECIS",
              "RETIRE_PAR", "TELEPHONE_RETRAIT", "DATE_RETRAIT", "AGENCE_RETRAIT"
       FROM historique
       WHERE LOWER(COALESCE("NOM", '')) LIKE $1
          OR LOWER(COALESCE("PRENOMS", '')) LIKE $1
          OR LOWER(COALESCE("NOM", '') || ' ' || COALESCE("PRENOMS", '')) LIKE $1
          OR LOWER(COALESCE("NUM_SECU", '')) LIKE $1
          OR LOWER(COALESCE("NUMERO", '')) LIKE $1
       ORDER BY id DESC
       LIMIT $2`,
      [likeTerm, resteLimite]
    );

    const formattedHist = histRes.rows.map((h) => {
      const agOrig = normaliserAgence(h.AGENCE) || (h.AGENCE || "").toString().trim();
      const agRet = normaliserAgence(h.AGENCE_RETRAIT) || (h.AGENCE_RETRAIT || "").toString().trim();
      const retirePar = (h.RETIRE_PAR || "Inconnu").toString().trim();
      const dateRet = formaterDateFR(h.DATE_RETRAIT);
      return {
        ligneIndex: null,
        rangement: (h.RANGEMENT || "Archivé").toString().trim(),
        numSecu: formaterNumSecu(h.NUM_SECU, h.NUMERO),
        nom: (h.NOM || "").toString().trim(),
        prenoms: (h.PRENOMS || "").toString().trim(),
        dateNaissance: formaterDateFR(h.DATE_NAISSANCE),
        agence: agOrig || agRet,
        agenceNorm: normaliserAgence(agOrig || agRet),
        sousPrefecture: normaliserTexte(h["SOUS-PREFECTURE"] || ""),
        lieuPrecis: (h.LIEU_PRECIS || "").toString().trim(),
        statut: `Carte Retirée par ${retirePar} le ${dateRet}`,
        retirePar,
        dateRetrait: dateRet,
        agenceRetrait: agRet,
        estRetiree: true
      };
    });

    return res.json(formattedActives.concat(formattedHist));
  } catch (err) {
    res.status(500).json({ error: "Erreur recherche : " + err.message });
  }
});

// --- 3. Statistiques de stock et réacheminements actifs ---
app.get("/api/stats", async (req, res) => {
  try {
    const agenceAgent = req.query.agence || "";

    const parDepartement = {
      BIANKOUMA: 0,
      DANANE: 0,
      MAN: 0,
      SIPILOU: 0,
      "ZOUAN-HOUNIEN": 0
    };

    const allAgRes = await pool.query(`SELECT "AGENCE" FROM cartes`);
    const totalRegional = allAgRes.rows.length;

    const matchAgenceContient = (valAgence, cible) => {
      const a = normaliserTexte(valAgence || "");
      const c = normaliserTexte(cible || "");
      if (!a || !c) return false;
      if (a.includes(c)) return true;
      const aliasMap = {
        BIANKOUMA: ["BK"],
        DANANE: ["DAN"],
        MAN: ["MAN"],
        SIPILOU: ["SIP"],
        "ZOUAN-HOUNIEN": ["ZH", "ZOUAN"]
      };
      const aliases = aliasMap[c] || [];
      return aliases.some((al) => a === al || a.startsWith(al + " ") || a.endsWith(" " + al) || a.includes("-" + al));
    };

    for (const r of allAgRes.rows) {
      for (const dept of Object.keys(parDepartement)) {
        if (matchAgenceContient(r.AGENCE, dept)) {
          parDepartement[dept] += 1;
        }
      }
    }

    const transRes = await pool.query(
      `SELECT id, "RANGEMENT", "NUM_SECU", "NOM", "PRENOMS", "DATE_NAISSANCE", "NUMERO", "AGENCE", "STATUT_TRANSFERT"
       FROM cartes
       WHERE UPPER(COALESCE("STATUT_TRANSFERT", '')) LIKE '%DEMANDE DE REACHEMINEMENT%'
          OR UPPER(COALESCE("STATUT_TRANSFERT", '')) LIKE '%REACHEMINEMENT EN COURS%'
          OR UPPER(COALESCE("STATUT_TRANSFERT", '')) LIKE '%TRANSFERT%'
       ORDER BY id DESC`
    );

    const agenceAgentNorm = normaliserAgence(agenceAgent);
    const transfertsEnCours = [];

    for (const t of transRes.rows) {
      const statut = (t.STATUT_TRANSFERT || "").toString().trim();
      const statutNorm = normaliserTexte(statut);
      const agenceBrute = normaliserAgence(t.AGENCE) || (t.AGENCE || "").toString().trim();
      const agenceCarteNorm = normaliserAgence(agenceBrute);
      const agenceDemandeur = extraireAgenceDemandeur(statut);
      const estEnCours =
        statutNorm.indexOf("REACHEMINEMENT EN COURS") !== -1 ||
        statutNorm.indexOf("TRANSFERT") !== -1;
      const etape = estEnCours ? "EN_COURS" : "DEMANDE";

      const concerneAgence =
        Boolean(agenceAgentNorm) &&
        agenceAgentNorm !== "REGIONAL" &&
        ((agenceDemandeur && agenceDemandeur === agenceAgentNorm) ||
          (agenceCarteNorm && agenceCarteNorm === agenceAgentNorm));

      if (concerneAgence) {
        const numSecu = formaterNumSecu(t.NUM_SECU, t.NUMERO);
        const rangement = (t.RANGEMENT || "Non défini").toString().trim();
        const nom = (t.NOM || "").toString().trim();
        const prenoms = (t.PRENOMS || "").toString().trim();
        const dateNaissance = formaterDateFR(t.DATE_NAISSANCE);

        const telDetenteur = await trouverContactWhatsappAgence(agenceCarteNorm);
        const msgWhatsapp =
          `Bonjour cher responsable (${agenceBrute || agenceCarteNorm}),\n` +
          `Demande de réacheminement pour l'agence de ${agenceDemandeur || "demandeur"} :\n` +
          `- N° Sécu : ${numSecu}\n` +
          `- Rangement : ${rangement}\n` +
          `- Nom & Prénoms : ${nom} ${prenoms}\n` +
          `- Date de naissance : ${dateNaissance || "Non renseignée"}\n` +
          `Merci de valider l'envoi dans CMU FINDER TONKPI.`;

        const lienWhatsapp = telDetenteur
          ? `https://wa.me/${telDetenteur}?text=${encodeURIComponent(msgWhatsapp)}`
          : `https://wa.me/?text=${encodeURIComponent(msgWhatsapp)}`;

        transfertsEnCours.push({
          ligneIndex: t.id,
          rangement,
          numSecu,
          nom,
          prenoms,
          dateNaissance,
          agenceActuelle: agenceBrute || agenceCarteNorm,
          agenceActuelleNorm: agenceCarteNorm,
          agenceDemandeur,
          statut,
          etape,
          lienWhatsapp
        });
      }
    }

    res.json({
      totalRegional,
      parDepartement,
      transfertsEnCours
    });
  } catch (err) {
    res.status(500).json({ error: "Erreur statistiques : " + err.message });
  }
});

// --- 4a. Demander un réacheminement ---
app.post("/api/reacheminement/demander", async (req, res) => {
  try {
    const idCarte = Number(req.body.ligneIndex);
    const demandeurNorm = normaliserAgence(req.body.agenceDemandeur);

    const q = await pool.query(
      `SELECT id, "RANGEMENT", "NUM_SECU", "NOM", "PRENOMS", "DATE_NAISSANCE", "NUMERO", "AGENCE"
       FROM cartes WHERE id = $1 LIMIT 1`,
      [idCarte]
    );
    if (q.rows.length === 0) {
      return res.json({ success: false, message: "Carte introuvable dans CARTES." });
    }

    const carte = q.rows[0];
    const rangement = carte.RANGEMENT || "Non défini";
    const numSecu = formaterNumSecu(carte.NUM_SECU, carte.NUMERO);
    const nom = carte.NOM || "";
    const prenoms = carte.PRENOMS || "";
    const dateNais = formaterDateFR(carte.DATE_NAISSANCE);
    const agenceDetentrice = normaliserAgence(carte.AGENCE) || (carte.AGENCE ? carte.AGENCE.toString().trim() : "");

    const nouveauStatut =
      "DEMANDE DE REACHEMINEMENT VERS " +
      demandeurNorm +
      " (DEPUIS " +
      normaliserAgence(agenceDetentrice) +
      ")";

    await pool.query(`UPDATE cartes SET "STATUT_TRANSFERT" = $1 WHERE id = $2`, [
      nouveauStatut,
      idCarte
    ]);

    const telDestinataire = await trouverContactWhatsappAgence(agenceDetentrice);
    const messageWhatsapp =
      "Bonjour cher responsable (" +
      agenceDetentrice +
      "),\n" +
      "Une demande de réacheminement a été émise par l'agence de " +
      demandeurNorm +
      " pour la carte CMU suivante :\n" +
      "- N° Sécu : " +
      numSecu +
      "\n" +
      "- Rangement : " +
      rangement +
      "\n" +
      "- Nom & Prénoms : " +
      nom +
      " " +
      prenoms +
      "\n" +
      "- Date de naissance : " +
      (dateNais || "Non renseignée") +
      "\n" +
      "Merci de procéder au transfert et de valider l'envoi dans CMU FINDER TONKPI.";

    const lienWhatsapp = telDestinataire
      ? "https://wa.me/" + telDestinataire + "?text=" + encodeURIComponent(messageWhatsapp)
      : "https://wa.me/?text=" + encodeURIComponent(messageWhatsapp);

    res.json({
      success: true,
      message: "Demande de réacheminement enregistrée vers " + demandeurNorm + ".",
      lienWhatsapp: lienWhatsapp,
      messageWhatsapp: messageWhatsapp
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Erreur : " + err.message });
  }
});

// --- 4b. Validation de l'envoi ---
app.post("/api/reacheminement/expedier", async (req, res) => {
  try {
    const idCarte = Number(req.body.ligneIndex);
    const q = await pool.query(
      `SELECT id, "AGENCE", "STATUT_TRANSFERT" FROM cartes WHERE id = $1 LIMIT 1`,
      [idCarte]
    );
    if (q.rows.length === 0) {
      return res.status(404).json({ message: "Carte introuvable." });
    }

    const statutActuel = (q.rows[0].STATUT_TRANSFERT || "").toString();
    const cible = req.body.agenceDemandeurCible
      ? normaliserAgence(req.body.agenceDemandeurCible)
      : extraireAgenceDemandeur(statutActuel);

    if (!cible || cible === "REGIONAL") {
      return res
        .status(400)
        .json({ message: "Agence demanderesse introuvable pour ce réacheminement." });
    }

    await pool.query(
      `UPDATE cartes SET "AGENCE" = $1, "STATUT_TRANSFERT" = 'Carte réacheminée' WHERE id = $2`,
      [cible, idCarte]
    );

    res.json({
      success: true,
      message:
        "Succès : Carte transférée vers " + cible + " et marquée 'Carte réacheminée'.",
      nouvelleAgence: cible
    });
  } catch (err) {
    res.status(500).json({ message: "Erreur : " + err.message });
  }
});

// --- 5. Retrait en transaction SQL ---
app.post("/api/cartes/retirer", async (req, res) => {
  const client = await pool.connect();
  try {
    const idCarte = Number(req.body.ligneIndex);
    const retirePar = (req.body.retirePar || "").toString().trim();
    const telFormate = formaterTelephone10(req.body.telephoneRetrait);
    const agenceRetrait = normaliserAgence(req.body.agenceAgent);

    if (!retirePar || !/^\d{10}$/.test(telFormate)) {
      return res
        .status(400)
        .json({ message: "Nom/prénoms ou contact à 10 chiffres invalide." });
    }

    await client.query("BEGIN");

    const sel = await client.query(
      `SELECT id, "RANGEMENT", "NUM_SECU", "NOM", "PRENOMS", "DATE_NAISSANCE", "NUMERO", "AGENCE", "SOUS-PREFECTURE", "LIEU_PRECIS"
       FROM cartes WHERE id = $1 FOR UPDATE`,
      [idCarte]
    );

    if (sel.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Carte introuvable ou déjà retirée." });
    }

    const c = sel.rows[0];
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const dateFormatee = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const agOrigMaj = normaliserAgence(c.AGENCE) || (c.AGENCE || "").toString().trim();
    const sousPrefMaj = normaliserTexte(c["SOUS-PREFECTURE"] || "") || normaliserTexte(c.LIEU_PRECIS || "") || agOrigMaj;

    await client.query(
      `INSERT INTO historique (
        "RANGEMENT", "NUM_SECU", "NOM", "PRENOMS", "DATE_NAISSANCE", "NUMERO", "AGENCE", "SOUS-PREFECTURE", "LIEU_PRECIS",
        "RETIRE_PAR", "TELEPHONE_RETRAIT", "DATE_RETRAIT", "AGENCE_RETRAIT"
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        c.RANGEMENT || "",
        formaterNumSecu(c.NUM_SECU, c.NUMERO),
        c.NOM || "",
        c.PRENOMS || "",
        formaterDateFR(c.DATE_NAISSANCE),
        c.NUMERO || "",
        agOrigMaj,
        sousPrefMaj,
        c.LIEU_PRECIS || "",
        retirePar,
        telFormate,
        dateFormatee,
        agenceRetrait
      ]
    );

    await client.query(`DELETE FROM cartes WHERE id = $1`, [idCarte]);
    await client.query("COMMIT");

    res.json({ message: "Succès : Carte retirée et archivée dans l'HISTORIQUE." });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ message: "Erreur lors du retrait : " + err.message });
  } finally {
    client.release();
  }
});

// --- 6. Historique des cartes retirées ---
app.get("/api/historique", async (req, res) => {
  try {
    const q = await pool.query(
      `SELECT "RANGEMENT", "NUM_SECU", "NOM", "PRENOMS", "DATE_NAISSANCE", "NUMERO", "AGENCE", "SOUS-PREFECTURE", "LIEU_PRECIS",
              "RETIRE_PAR", "TELEPHONE_RETRAIT", "DATE_RETRAIT", "AGENCE_RETRAIT"
       FROM historique
       ORDER BY id DESC
       LIMIT 500`
    );

    const list = q.rows.map((h) => {
      const agOrig = normaliserAgence(h.AGENCE) || (h.AGENCE || "").toString().trim();
      const agRet = normaliserAgence(h.AGENCE_RETRAIT) || (h.AGENCE_RETRAIT || "").toString().trim();
      return {
        rangement: h.RANGEMENT || "",
        numSecu: formaterNumSecu(h.NUM_SECU, h.NUMERO),
        nom: h.NOM || "",
        prenoms: h.PRENOMS || "",
        dateNaissance: formaterDateFR(h.DATE_NAISSANCE),
        agenceOrigine: agOrig,
        agenceOrigineNorm: normaliserAgence(agOrig),
        sousPrefecture: normaliserTexte(h["SOUS-PREFECTURE"] || ""),
        lieuPrecis: h.LIEU_PRECIS || "",
        retirePar: h.RETIRE_PAR || "",
        telephone: formaterTelephone10(h.TELEPHONE_RETRAIT),
        dateRetrait: formaterDateFR(h.DATE_RETRAIT),
        agenceRetrait: agRet,
        agenceRetraitNorm: normaliserAgence(agRet)
      };
    });

    res.json(list);
  } catch (err) {
    res.status(500).json({ error: "Erreur historique : " + err.message });
  }
});

// --- 7. Import massif de cartes (ignore les lignes entières déjà présentes) ---
app.post("/api/cartes/import", async (req, res) => {
  const client = await pool.connect();
  try {
    if (!estSuperviseurOuCe(req.body.role, req.body.agence)) {
      return res.status(403).json({ message: "Accès réservé aux profils SUP et CE." });
    }

    const lignes = Array.isArray(req.body.cartes) ? req.body.cartes : [];
    if (lignes.length === 0) {
      return res.status(400).json({ message: "Aucune ligne valide trouvée dans le fichier." });
    }
    if (lignes.length > 5000) {
      return res.status(400).json({ message: "Limite de 5 000 lignes par import dépassée." });
    }

    const agenceDefaut = normaliserAgence(req.body.agenceDefaut || "") || "";
    const sousPrefDefaut = normaliserTexte(req.body.sousPrefectureDefaut || "");

    const empreintesLot = new Set();
    let inserees = 0;
    let doublonsIgnores = 0;

    await client.query("BEGIN");

    for (const item of lignes) {
      const rangement = (item.rangement || "").toString().trim();
      const numSecu = (item.num_secu || item.numSecu || "").toString().trim();
      const nom = (item.nom || "").toString().trim();
      const prenoms = (item.prenoms || "").toString().trim();
      const dateNaissance = (item.date_naissance || item.dateNaissance || "").toString().trim();
      const numero = (item.numero || "").toString().trim();
      const agence =
        normaliserAgence(item.agence || "") ||
        normaliserTexte(item.agence || "") ||
        agenceDefaut;
      const lieuPrecis = (item.lieu_precis || item.lieuPrecis || "").toString().trim();
      const sousPrefRaw =
        item.sous_prefecture ||
        item.sousPrefecture ||
        item["sous-prefecture"] ||
        item["sous_prefecture"] ||
        sousPrefDefaut ||
        "";
      const sousPrefecture =
        normaliserTexte(sousPrefRaw) || normaliserTexte(lieuPrecis) || agence;
      const statutTransfert =
        (item.statut_transfert || item.statut || "DISPONIBLE").toString().trim() || "DISPONIBLE";

      if (!nom && !prenoms && !numSecu && !numero) continue;

      const rNorm = normaliserTexte(rangement);
      const nsNorm = normaliserTexte(numSecu);
      const nomNorm = normaliserTexte(nom);
      const prenNorm = normaliserTexte(prenoms);
      const dnNorm = normaliserTexte(dateNaissance);
      const numNorm = normaliserTexte(numero);
      const agNorm = normaliserTexte(agence);
      const spNorm = normaliserTexte(sousPrefecture);
      const lpNorm = normaliserTexte(lieuPrecis);

      const empreinte = [rNorm, nsNorm, nomNorm, prenNorm, dnNorm, numNorm, agNorm, spNorm, lpNorm].join("|");

      if (empreintesLot.has(empreinte)) {
        doublonsIgnores++;
        continue;
      }
      empreintesLot.add(empreinte);

      const existCartes = await client.query(
        `SELECT 1 FROM cartes
         WHERE UPPER(TRIM(COALESCE("RANGEMENT", ''))) = $1
           AND UPPER(TRIM(COALESCE("NUM_SECU", ''))) = $2
           AND UPPER(TRIM(COALESCE("NOM", ''))) = $3
           AND UPPER(TRIM(COALESCE("PRENOMS", ''))) = $4
           AND UPPER(TRIM(COALESCE("DATE_NAISSANCE", ''))) = $5
           AND UPPER(TRIM(COALESCE("NUMERO", ''))) = $6
           AND UPPER(TRIM(COALESCE("AGENCE", ''))) = $7
           AND UPPER(TRIM(COALESCE("SOUS-PREFECTURE", ''))) = $8
           AND UPPER(TRIM(COALESCE("LIEU_PRECIS", ''))) = $9
         LIMIT 1`,
        [rNorm, nsNorm, nomNorm, prenNorm, dnNorm, numNorm, agNorm, spNorm, lpNorm]
      );

      if (existCartes.rows.length > 0) {
        doublonsIgnores++;
        continue;
      }

      const existHist = await client.query(
        `SELECT 1 FROM historique
         WHERE UPPER(TRIM(COALESCE("NUM_SECU", ''))) = $1
           AND UPPER(TRIM(COALESCE("NOM", ''))) = $2
           AND UPPER(TRIM(COALESCE("PRENOMS", ''))) = $3
           AND UPPER(TRIM(COALESCE("DATE_NAISSANCE", ''))) = $4
           AND UPPER(TRIM(COALESCE("NUMERO", ''))) = $5
         LIMIT 1`,
        [nsNorm, nomNorm, prenNorm, dnNorm, numNorm]
      );

      if (existHist.rows.length > 0) {
        doublonsIgnores++;
        continue;
      }

      await client.query(
        `INSERT INTO cartes (
          "RANGEMENT", "NUM_SECU", "NOM", "PRENOMS", "DATE_NAISSANCE", "NUMERO", "AGENCE", "SOUS-PREFECTURE", "LIEU_PRECIS", "STATUT_TRANSFERT"
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          rangement,
          numSecu,
          nom,
          prenoms,
          dateNaissance,
          numero,
          agence,
          sousPrefecture,
          lieuPrecis,
          statutTransfert
        ]
      );
      inserees++;
    }

    await client.query("COMMIT");

    res.json({
      message: `Import terminé : ${inserees} nouvelle(s) carte(s) ajoutée(s), ${doublonsIgnores} doublon(s) ignoré(s).`
    });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ message: "Erreur lors de l'import : " + err.message });
  } finally {
    client.release();
  }
});

// --- 8. Export CSV du stock actif pour SurveyCTO ---
app.get("/api/surveycto/export", async (req, res) => {
  try {
    const role = req.query.role || "";
    const agenceQuery = req.query.agence || "";
    if (!estSuperviseurOuCe(role, agenceQuery)) {
      return res.status(403).json({ message: "Accès réservé aux profils SUP et CE." });
    }

    const q = await pool.query(
      `SELECT id, "RANGEMENT", "NUM_SECU", "NOM", "PRENOMS", "DATE_NAISSANCE", "NUMERO", "AGENCE", "SOUS-PREFECTURE", "LIEU_PRECIS"
       FROM cartes
       ORDER BY id ASC`
    );

    const entetes = [
      "cle_carte",
      "id_carte",
      "num_secu",
      "numero",
      "nom_complet",
      "date_naissance",
      "rangement",
      "agence",
      "sous_prefecture",
      "lieu_precis"
    ];

    const lignesCsv = [entetes.join(",")];

    for (const r of q.rows) {
      const agNorm = normaliserAgence(r.AGENCE) || normaliserTexte(r.AGENCE || "");
      const lieu = (r.LIEU_PRECIS || "").toString().trim();
      const sousPref = normaliserTexte(r["SOUS-PREFECTURE"] || "") || normaliserTexte(lieu) || agNorm;
      const nomComplet = `${(r.NOM || "").toString().trim()} ${(r.PRENOMS || "").toString().trim()}`.trim();
      const numSecu = (r.NUM_SECU || "").toString().trim();
      const numero = (r.NUMERO || "").toString().trim();
      const cleCarte = `${r.id}_${numSecu || numero || "SANS_NUM"}`;

      const rowVals = [
        cleCarte,
        r.id,
        numSecu,
        numero,
        nomComplet,
        formaterDateFR(r.DATE_NAISSANCE),
        (r.RANGEMENT || "").toString().trim(),
        agNorm,
        sousPref,
        lieu || sousPref || agNorm
      ];

      lignesCsv.push(rowVals.map(echapperCsv).join(","));
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="cartes_stock.csv"');
    res.send("\uFEFF" + lignesCsv.join("\r\n"));
  } catch (err) {
    res.status(500).json({ message: "Erreur export SurveyCTO : " + err.message });
  }
});

// --- 9. Synchronisation des retraits SurveyCTO vers HISTORIQUE ---
app.post("/api/surveycto/sync", async (req, res) => {
  const client = await pool.connect();
  try {
    if (!estSuperviseurOuCe(req.body.role, req.body.agence)) {
      return res.status(403).json({ message: "Accès réservé aux profils SUP et CE." });
    }

    const soumissions = Array.isArray(req.body.soumissions) ? req.body.soumissions : [];
    if (soumissions.length === 0) {
      return res.status(400).json({ message: "Aucune soumission valide trouvée dans le CSV." });
    }

    let archivees = 0;
    let dejaTraitees = 0;
    let introuvables = 0;

    await client.query("BEGIN");

    for (const s of soumissions) {
      const idCarteRaw = (s.carte_id || s.id_carte || s.id || "").toString().trim();
      const numSecuRaw = (s.carte_num_secu || s.num_secu || "").toString().trim();
      const numeroRaw = (s.carte_numero || s.numero || "").toString().trim();
      const retirePar = (s.retire_par || s.nom_mandataire || s.carte_titulaire || "").toString().trim();
      const telFormate = formaterTelephone10(s.telephone_retrait || s.telephone || "");

      const identifiantAgent = normaliserTexte(s.identifiant_valide || s.identifiant_saisi || s.identifiant || "");
      const agenceNorm = normaliserAgence(s.agence || "") || "MAN";
      const agenceRetrait =
        normaliserTexte(s.agence_retrait || "") ||
        (identifiantAgent ? `${agenceNorm}-(${identifiantAgent})` : agenceNorm);

      const dateRetrait =
        (s.date_retrait || s.submissiondate || s.endtime || "").toString().trim() ||
        formaterDateFR(new Date());

      if (!retirePar || !/^\d{10}$/.test(telFormate)) {
        introuvables++;
        continue;
      }

      let carteRow = null;

      if (/^\d+$/.test(idCarteRaw)) {
        const qId = await client.query(
          `SELECT id, "RANGEMENT", "NUM_SECU", "NOM", "PRENOMS", "DATE_NAISSANCE", "NUMERO", "AGENCE", "SOUS-PREFECTURE", "LIEU_PRECIS"
           FROM cartes WHERE id = $1 FOR UPDATE`,
          [Number(idCarteRaw)]
        );
        if (qId.rows.length > 0) carteRow = qId.rows[0];
      }

      if (!carteRow && numSecuRaw) {
        const qSecu = await client.query(
          `SELECT id, "RANGEMENT", "NUM_SECU", "NOM", "PRENOMS", "DATE_NAISSANCE", "NUMERO", "AGENCE", "SOUS-PREFECTURE", "LIEU_PRECIS"
           FROM cartes WHERE TRIM("NUM_SECU") = $1 FOR UPDATE LIMIT 1`,
          [numSecuRaw]
        );
        if (qSecu.rows.length > 0) carteRow = qSecu.rows[0];
      }

      if (!carteRow && numeroRaw) {
        const qNum = await client.query(
          `SELECT id, "RANGEMENT", "NUM_SECU", "NOM", "PRENOMS", "DATE_NAISSANCE", "NUMERO", "AGENCE", "SOUS-PREFECTURE", "LIEU_PRECIS"
           FROM cartes WHERE TRIM("NUMERO") = $1 FOR UPDATE LIMIT 1`,
          [numeroRaw]
        );
        if (qNum.rows.length > 0) carteRow = qNum.rows[0];
      }

      if (!carteRow) {
        const refVerif = numSecuRaw || numeroRaw;
        if (refVerif) {
          const qHist = await client.query(
            `SELECT id FROM historique WHERE TRIM("NUM_SECU") = $1 OR TRIM("NUMERO") = $1 LIMIT 1`,
            [refVerif]
          );
          if (qHist.rows.length > 0) {
            dejaTraitees++;
            continue;
          }
        }
        introuvables++;
        continue;
      }

      const agCarteMaj = normaliserAgence(carteRow.AGENCE) || (carteRow.AGENCE || "").toString().trim();
      const sousPrefMaj =
        normaliserTexte(carteRow["SOUS-PREFECTURE"] || "") ||
        normaliserTexte(carteRow.LIEU_PRECIS || "") ||
        agCarteMaj;

      await client.query(
        `INSERT INTO historique (
          "RANGEMENT", "NUM_SECU", "NOM", "PRENOMS", "DATE_NAISSANCE", "NUMERO", "AGENCE", "SOUS-PREFECTURE", "LIEU_PRECIS",
          "RETIRE_PAR", "TELEPHONE_RETRAIT", "DATE_RETRAIT", "AGENCE_RETRAIT"
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          carteRow.RANGEMENT || "",
          formaterNumSecu(carteRow.NUM_SECU, carteRow.NUMERO),
          carteRow.NOM || "",
          carteRow.PRENOMS || "",
          formaterDateFR(carteRow.DATE_NAISSANCE),
          carteRow.NUMERO || "",
          agCarteMaj,
          sousPrefMaj,
          carteRow.LIEU_PRECIS || "",
          retirePar,
          telFormate,
          dateRetrait,
          agenceRetrait
        ]
      );

      await client.query(`DELETE FROM cartes WHERE id = $1`, [carteRow.id]);
      archivees++;
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message: `Synchronisation SurveyCTO terminée : ${archivees} carte(s) archivée(s), ${dejaTraitees} déjà traitée(s), ${introuvables} non trouvée(s)/incomplète(s).`
    });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ message: "Erreur synchronisation SurveyCTO : " + err.message });
  } finally {
    client.release();
  }
});

// --- 10. Chargement du stock terrain (AGENCE contient cible ; SOUS-PREFECTURE contient localite) ---
app.get("/api/terrain/cartes", async (req, res) => {
  try {
    const agenceBrute = (req.query.agence || "").toString().trim();
    const agenceFiltre = normaliserAgence(agenceBrute) || normaliserTexte(agenceBrute);
    const localiteBrute =
      req.query.localite || req.query.sous_prefecture || req.query.sousPrefecture || "";
    const localiteFiltre = normaliserTexte(localiteBrute);

    const agenceContient = (valAgence, cible) => {
      const a = normaliserTexte(valAgence || "");
      const c = normaliserTexte(cible || "");
      if (!a || !c) return false;
      if (a.includes(c)) return true;
      const aliasMap = {
        BIANKOUMA: ["BK"],
        DANANE: ["DAN"],
        MAN: ["MAN"],
        SIPILOU: ["SIP"],
        "ZOUAN-HOUNIEN": ["ZH", "ZOUAN"]
      };
      const aliases = aliasMap[c] || [];
      return aliases.some((al) => a === al || a.startsWith(al + " ") || a.endsWith(" " + al) || a.includes("-" + al));
    };

    const q = await pool.query(
      `SELECT id, "RANGEMENT", "NUM_SECU", "NOM", "PRENOMS", "DATE_NAISSANCE", "NUMERO", "AGENCE", "SOUS-PREFECTURE", "LIEU_PRECIS", "STATUT_TRANSFERT"
       FROM cartes
       ORDER BY "NOM" ASC, "PRENOMS" ASC, id ASC`
    );

    const cartesFiltrees = [];
    const sousPrefSet = new Set();

    for (const r of q.rows) {
      const agBrut = (r.AGENCE || "").toString().trim();
      const agNorm = normaliserAgence(agBrut) || normaliserTexte(agBrut);
      const sousPrefColBrut = (r["SOUS-PREFECTURE"] || "").toString().trim();
      const sousPrefColNorm = normaliserTexte(sousPrefColBrut);
      const lieuBrut = (r.LIEU_PRECIS || "").toString().trim();

      if (agenceFiltre && !agenceContient(agBrut, agenceFiltre)) {
        continue;
      }

      if (sousPrefColNorm) {
        sousPrefSet.add(sousPrefColNorm);
      }

      if (localiteFiltre) {
        if (!sousPrefColNorm.includes(localiteFiltre)) {
          continue;
        }
      }

      cartesFiltrees.push({
        id: r.id,
        rangement: (r.RANGEMENT || "Non défini").toString().trim(),
        numSecu: formaterNumSecu(r.NUM_SECU, r.NUMERO),
        numSecuBrut: (r.NUM_SECU || "").toString().trim(),
        numero: (r.NUMERO || "").toString().trim(),
        nom: (r.NOM || "").toString().trim(),
        prenoms: (r.PRENOMS || "").toString().trim(),
        dateNaissance: formaterDateFR(r.DATE_NAISSANCE),
        agence: agNorm || agBrut,
        sousPrefecture: sousPrefColNorm,
        lieuPrecis: lieuBrut || sousPrefColNorm || agNorm
      });
    }

    res.json({
      agence: agenceFiltre || "TOUTES",
      localite: localiteFiltre || "TOUTES",
      sousPrefectures: Array.from(sousPrefSet).sort(),
      total: cartesFiltrees.length,
      cartes: cartesFiltrees
    });
  } catch (err) {
    res.status(500).json({ error: "Erreur chargement stock terrain : " + err.message });
  }
});

// --- 11. Synchronisation des retraits effectués hors-ligne sur la PWA Terrain ---
app.post("/api/terrain/sync", async (req, res) => {
  const client = await pool.connect();
  try {
    const identifiantAgent = normaliserTexte(req.body.identifiant || "");
    const agenceParDefaut = normaliserAgence(req.body.agence || "") || "MAN";
    const retraits = Array.isArray(req.body.retraits) ? req.body.retraits : [];

    if (!identifiantAgent) {
      return res.status(400).json({ message: "Identifiant agent requis pour la synchronisation." });
    }
    if (retraits.length === 0) {
      return res.status(400).json({ message: "Aucun retrait en attente à synchroniser." });
    }

    let synchronises = 0;
    let dejaTraites = 0;
    let erreurs = 0;
    const idsSynchronises = [];

    await client.query("BEGIN");

    for (const item of retraits) {
      const idLocal = item.idLocal || null;
      const idCarte = Number(item.carteId);
      const numSecu = (item.numSecu || "").toString().trim();
      const numero = (item.numero || "").toString().trim();
      const retirePar = (item.retirePar || "").toString().trim();
      const telFormate = formaterTelephone10(item.telephoneRetrait || "");
      const agCarte = normaliserAgence(item.agence || agenceParDefaut) || agenceParDefaut;
      const agenceRetrait =
        normaliserTexte(item.agenceRetrait || "") || `${agCarte}-(${identifiantAgent})`;
      const dateRetrait =
        (item.dateRetrait || "").toString().trim() || formaterDateFR(new Date());

      if (!retirePar || !/^\d{10}$/.test(telFormate)) {
        erreurs++;
        continue;
      }

      let carteRow = null;

      if (Number.isInteger(idCarte) && idCarte > 0) {
        const qId = await client.query(
          `SELECT id, "RANGEMENT", "NUM_SECU", "NOM", "PRENOMS", "DATE_NAISSANCE", "NUMERO", "AGENCE", "SOUS-PREFECTURE", "LIEU_PRECIS"
           FROM cartes WHERE id = $1 FOR UPDATE`,
          [idCarte]
        );
        if (qId.rows.length > 0) carteRow = qId.rows[0];
      }

      if (!carteRow && numSecu && numSecu !== "Non renseigné") {
        const qSecu = await client.query(
          `SELECT id, "RANGEMENT", "NUM_SECU", "NOM", "PRENOMS", "DATE_NAISSANCE", "NUMERO", "AGENCE", "SOUS-PREFECTURE", "LIEU_PRECIS"
           FROM cartes WHERE TRIM("NUM_SECU") = $1 FOR UPDATE LIMIT 1`,
          [numSecu]
        );
        if (qSecu.rows.length > 0) carteRow = qSecu.rows[0];
      }

      if (!carteRow && numero) {
        const qNum = await client.query(
          `SELECT id, "RANGEMENT", "NUM_SECU", "NOM", "PRENOMS", "DATE_NAISSANCE", "NUMERO", "AGENCE", "SOUS-PREFECTURE", "LIEU_PRECIS"
           FROM cartes WHERE TRIM("NUMERO") = $1 FOR UPDATE LIMIT 1`,
          [numero]
        );
        if (qNum.rows.length > 0) carteRow = qNum.rows[0];
      }

      if (!carteRow) {
        const refVerif = (numSecu && numSecu !== "Non renseigné" ? numSecu : "") || numero;
        if (refVerif) {
          const qHist = await client.query(
            `SELECT id FROM historique WHERE TRIM("NUM_SECU") = $1 OR TRIM("NUMERO") = $1 LIMIT 1`,
            [refVerif]
          );
          if (qHist.rows.length > 0) {
            dejaTraites++;
            if (idLocal) idsSynchronises.push(idLocal);
            continue;
          }
        }
        erreurs++;
        continue;
      }

      const agCarteMaj = normaliserAgence(carteRow.AGENCE) || agCarte;
      const sousPrefMaj =
        normaliserTexte(carteRow["SOUS-PREFECTURE"] || "") ||
        normaliserTexte(carteRow.LIEU_PRECIS || "") ||
        agCarteMaj;

      await client.query(
        `INSERT INTO historique (
          "RANGEMENT", "NUM_SECU", "NOM", "PRENOMS", "DATE_NAISSANCE", "NUMERO", "AGENCE", "SOUS-PREFECTURE", "LIEU_PRECIS",
          "RETIRE_PAR", "TELEPHONE_RETRAIT", "DATE_RETRAIT", "AGENCE_RETRAIT"
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          carteRow.RANGEMENT || "",
          formaterNumSecu(carteRow.NUM_SECU, carteRow.NUMERO),
          carteRow.NOM || "",
          carteRow.PRENOMS || "",
          formaterDateFR(carteRow.DATE_NAISSANCE),
          carteRow.NUMERO || "",
          agCarteMaj,
          sousPrefMaj,
          carteRow.LIEU_PRECIS || "",
          retirePar,
          telFormate,
          dateRetrait,
          agenceRetrait
        ]
      );

      await client.query(`DELETE FROM cartes WHERE id = $1`, [carteRow.id]);
      synchronises++;
      if (idLocal) idsSynchronises.push(idLocal);
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      synchronises,
      dejaTraites,
      erreurs,
      idsSynchronises,
      message: `Synchro terminée : ${synchronises} carte(s) archivée(s), ${dejaTraites} déjà traitée(s), ${erreurs} non trouvée(s).`
    });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ message: "Erreur synchronisation terrain : " + err.message });
  } finally {
    client.release();
  }
});

app.listen(PORT, () => {
  console.log(`API CMU FINDER TONKPI démarrée sur le port ${PORT}`);
});
