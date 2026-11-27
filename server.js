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
    `SELECT agence, numero FROM utilisateurs WHERE numero IS NOT NULL AND TRIM(numero) <> ''`
  );
  for (const row of res.rows) {
    if (normaliserAgence(row.agence) === cibleNorm) {
      const wa = nettoyerTelephoneWhatsapp(row.numero);
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
  res.json({ ok: true, service: "CMU FINDER TONKPI API", version: "3.0-ACCES" });
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
      `SELECT id, agence, nom_prenoms, identifiant, mot_de_passe, role, numero, tentatives_suspension
       FROM utilisateurs
       WHERE UPPER(TRIM(identifiant)) = $1
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
    const etatSecu = (user.tentatives_suspension || "").toString().trim();
    const dbAgence = (user.agence || "").toString().trim();
    const dbNom = (user.nom_prenoms || "").toString().trim();
    const dbPass = (user.mot_de_passe || "").toString().trim();
    const dbRole = user.role ? normaliserTexte(user.role) : "AGENT";

    if (dbPass === passRecherche) {
      if (etatSecu !== "") {
        await pool.query(`UPDATE utilisateurs SET tentatives_suspension = '' WHERE id = $1`, [user.id]);
      }
      const agenceEffective = dbAgence || normaliserAgence(user.identifiant);
      return res.json({
        success: true,
        identifiant: (user.identifiant || idRecherche).toString().trim().toUpperCase(),
        nomComplet: dbNom || user.identifiant,
        agence: agenceEffective,
        agenceNorm: normaliserAgence(agenceEffective),
        role: dbRole,
        whatsapp: formaterTelephone10(user.numero)
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
    const motDePasse = (req.body.password || "").toString().trim();
    const numeroTel = formaterTelephone10(req.body.numero || "");

    if (!idNouveau || !nomPrenoms || !motDePasse || motDePasse.length < 4) {
      return res.status(400).json({
        success: false,
        message: "Identifiant, nom/prénoms et mot de passe (4 caractères minimum) sont obligatoires."
      });
    }

    const existant = await pool.query(
      `SELECT id FROM utilisateurs WHERE UPPER(TRIM(identifiant)) = $1 LIMIT 1`,
      [idNouveau]
    );
    if (extant.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: `L'identifiant '${idNouveau}' existe déjà.`
      });
    }

    const ins = await pool.query(
      `INSERT INTO utilisateurs (agence, nom_prenoms, identifiant, mot_de_passe, role, numero, tentatives_suspension)
       VALUES ($1, $2, $3, $4, $5, $6, '')
       RETURNING id, agence, nom_prenoms, identifiant, role, numero`,
      [agenceCible, nomPrenoms, idNouveau, motDePasse, roleCible, numeroTel]
    );

    const compte = ins.rows[0];
    return res.status(201).json({
      success: true,
      message: `Accès créé pour ${compte.identifiant} (${compte.role} • ${compte.agence}) par ${demandeurIdNorm || demandeurRoleNorm}.`,
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
      `SELECT id, identifiant, role, agence FROM utilisateurs WHERE UPPER(TRIM(identifiant)) = $1 LIMIT 1`,
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
      `UPDATE utilisateurs SET mot_de_passe = $1, tentatives_suspension = '' WHERE id = $2`,
      [nouveauMotDePasse, cible.id]
    );

    return res.json({
      success: true,
      message: `Mot de passe mis à jour pour ${cible.identifiant} (modifié par ${demandeurIdNorm || demandeurRoleNorm}).`
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Erreur serveur lors du changement de mot de passe : " + err.message
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
      `SELECT id, rangement, num_secu, nom, prenoms, date_naissance, numero, agence, lieu_precis, statut_transfert
       FROM cartes
       WHERE LOWER(TRIM(COALESCE(num_secu, ''))) = $1
          OR LOWER(TRIM(COALESCE(numero, ''))) = $1
       LIMIT $2`,
      [terme, limite]
    );

    let rowsCartes = exactRes.rows;

    if (rowsCartes.length < limite) {
      const existingIds = rowsCartes.map((r) => r.id);
      const partRes = await pool.query(
        `SELECT id, rangement, num_secu, nom, prenoms, date_naissance, numero, agence, lieu_precis, statut_transfert
         FROM cartes
         WHERE (
           LOWER(COALESCE(nom, '')) LIKE $1
           OR LOWER(COALESCE(prenoms, '')) LIKE $1
           OR LOWER(COALESCE(nom, '') || ' ' || COALESCE(prenoms, '')) LIKE $1
           OR LOWER(COALESCE(num_secu, '')) LIKE $1
           OR LOWER(COALESCE(numero, '')) LIKE $1
         )
         AND NOT (id = ANY($2::int[]))
         LIMIT $3`,
        [likeTerm, existingIds.length ? existingIds : [0], limite - rowsCartes.length]
      );
      rowsCartes = rowsCartes.concat(partRes.rows);
    }

    const formattedActives = rowsCartes.map((r) => {
      const agence = (r.agence || "Non définie").toString().trim();
      return {
        ligneIndex: r.id,
        rangement: (r.rangement || "Non défini").toString().trim(),
        numSecu: formaterNumSecu(r.num_secu, r.numero),
        nom: (r.nom || "").toString().trim(),
        prenoms: (r.prenoms || "").toString().trim(),
        dateNaissance: formaterDateFR(r.date_naissance),
        agence,
        agenceNorm: normaliserAgence(agence),
        lieuPrecis: (r.lieu_precis || "Non défini").toString().trim(),
        statut: (r.statut_transfert || "DISPONIBLE").toString().trim(),
        estRetiree: false
      };
    });

    const resteLimite = Math.max(10, limite - formattedActives.length);
    const histRes = await pool.query(
      `SELECT id, rangement, num_secu, nom, prenoms, date_naissance, numero, agence, lieu_precis,
              retire_par, telephone_retrait, date_retrait, agence_retrait
       FROM historique
       WHERE LOWER(COALESCE(nom, '')) LIKE $1
          OR LOWER(COALESCE(prenoms, '')) LIKE $1
          OR LOWER(COALESCE(nom, '') || ' ' || COALESCE(prenoms, '')) LIKE $1
          OR LOWER(COALESCE(num_secu, '')) LIKE $1
          OR LOWER(COALESCE(numero, '')) LIKE $1
       ORDER BY id DESC
       LIMIT $2`,
      [likeTerm, resteLimite]
    );

    const formattedHist = histRes.rows.map((h) => {
      const agOrig = (h.agence || "").toString().trim();
      const agRet = (h.agence_retrait || "").toString().trim();
      const retirePar = (h.retire_par || "Inconnu").toString().trim();
      const dateRet = formaterDateFR(h.date_retrait);
      return {
        ligneIndex: null,
        rangement: (h.rangement || "Archivé").toString().trim(),
        numSecu: formaterNumSecu(h.num_secu, h.numero),
        nom: (h.nom || "").toString().trim(),
        prenoms: (h.prenoms || "").toString().trim(),
        dateNaissance: formaterDateFR(h.date_naissance),
        agence: agOrig || agRet,
        agenceNorm: normaliserAgence(agOrig || agRet),
        lieuPrecis: (h.lieu_precis || "").toString().trim(),
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
    let totalRegional = 0;

    const countRes = await pool.query(
      `SELECT agence, COUNT(*)::int AS total FROM cartes GROUP BY agence`
    );
    for (const r of countRes.rows) {
      const norm = normaliserAgence(r.agence);
      const cnt = Number(r.total) || 0;
      totalRegional += cnt;
      if (parDepartement[norm] !== undefined) {
        parDepartement[norm] += cnt;
      }
    }

    const transRes = await pool.query(
      `SELECT id, rangement, num_secu, nom, prenoms, date_naissance, numero, agence, statut_transfert
       FROM cartes
       WHERE UPPER(COALESCE(statut_transfert, '')) LIKE '%DEMANDE DE REACHEMINEMENT%'
          OR UPPER(COALESCE(statut_transfert, '')) LIKE '%REACHEMINEMENT EN COURS%'
          OR UPPER(COALESCE(statut_transfert, '')) LIKE '%TRANSFERT%'
       ORDER BY id DESC`
    );

    const agenceAgentNorm = normaliserAgence(agenceAgent);
    const transfertsEnCours = [];

    for (const t of transRes.rows) {
      const statut = (t.statut_transfert || "").toString().trim();
      const statutNorm = normaliserTexte(statut);
      const agenceBrute = (t.agence || "").toString().trim();
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
        const numSecu = formaterNumSecu(t.num_secu, t.numero);
        const rangement = (t.rangement || "Non défini").toString().trim();
        const nom = (t.nom || "").toString().trim();
        const prenoms = (t.prenoms || "").toString().trim();
        const dateNaissance = formaterDateFR(t.date_naissance);

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
      `SELECT id, rangement, num_secu, nom, prenoms, date_naissance, numero, agence
       FROM cartes WHERE id = $1 LIMIT 1`,
      [idCarte]
    );
    if (q.rows.length === 0) {
      return res.json({ success: false, message: "Carte introuvable dans CARTES." });
    }

    const carte = q.rows[0];
    const rangement = carte.rangement || "Non défini";
    const numSecu = formaterNumSecu(carte.num_secu, carte.numero);
    const nom = carte.nom || "";
    const prenoms = carte.prenoms || "";
    const dateNais = formaterDateFR(carte.date_naissance);
    const agenceDetentrice = carte.agence ? carte.agence.toString().trim() : "";

    const nouveauStatut =
      "DEMANDE DE REACHEMINEMENT VERS " +
      demandeurNorm +
      " (DEPUIS " +
      normaliserAgence(agenceDetentrice) +
      ")";

    await pool.query(`UPDATE cartes SET statut_transfert = $1 WHERE id = $2`, [
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
      `SELECT id, agence, statut_transfert FROM cartes WHERE id = $1 LIMIT 1`,
      [idCarte]
    );
    if (q.rows.length === 0) {
      return res.status(404).json({ message: "Carte introuvable." });
    }

    const statutActuel = (q.rows[0].statut_transfert || "").toString();
    const cible = req.body.agenceDemandeurCible
      ? normaliserAgence(req.body.agenceDemandeurCible)
      : extraireAgenceDemandeur(statutActuel);

    if (!cible || cible === "REGIONAL") {
      return res
        .status(400)
        .json({ message: "Agence demanderesse introuvable pour ce réacheminement." });
    }

    await pool.query(
      `UPDATE cartes SET agence = $1, statut_transfert = 'Carte réacheminée' WHERE id = $2`,
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
      `SELECT id, rangement, num_secu, nom, prenoms, date_naissance, numero, agence, lieu_precis
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

    await client.query(
      `INSERT INTO historique (
        rangement, num_secu, nom, prenoms, date_naissance, numero, agence, lieu_precis,
        retire_par, telephone_retrait, date_retrait, agence_retrait
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        c.rangement || "",
        formaterNumSecu(c.num_secu, c.numero),
        c.nom || "",
        c.prenoms || "",
        formaterDateFR(c.date_naissance),
        c.numero || "",
        c.agence || "",
        c.lieu_precis || "",
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
      `SELECT rangement, num_secu, nom, prenoms, date_naissance, numero, agence, lieu_precis,
              retire_par, telephone_retrait, date_retrait, agence_retrait
       FROM historique
       ORDER BY id DESC
       LIMIT 500`
    );

    const list = q.rows.map((h) => {
      const agOrig = (h.agence || "").toString().trim();
      const agRet = (h.agence_retrait || "").toString().trim();
      return {
        rangement: h.rangement || "",
        numSecu: formaterNumSecu(h.num_secu, h.numero),
        nom: h.nom || "",
        prenoms: h.prenoms || "",
        dateNaissance: formaterDateFR(h.date_naissance),
        agenceOrigine: agOrig,
        agenceOrigineNorm: normaliserAgence(agOrig),
        lieuPrecis: h.lieu_precis || "",
        retirePar: h.retire_par || "",
        telephone: formaterTelephone10(h.telephone_retrait),
        dateRetrait: formaterDateFR(h.date_retrait),
        agenceRetrait: agRet,
        agenceRetraitNorm: normaliserAgence(agRet)
      };
    });

    res.json(list);
  } catch (err) {
    res.status(500).json({ error: "Erreur historique : " + err.message });
  }
});

// --- 7. Import massif de cartes depuis CSV ---
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

    let inserees = 0;
    let misesAJour = 0;

    await client.query("BEGIN");

    for (const item of lignes) {
      const rangement = (item.rangement || "").toString().trim();
      const numSecu = (item.num_secu || item.numSecu || "").toString().trim();
      const nom = (item.nom || "").toString().trim();
      const prenoms = (item.prenoms || "").toString().trim();
      const dateNaissance = (item.date_naissance || item.dateNaissance || "").toString().trim();
      const numero = (item.numero || "").toString().trim();
      const agence = normaliserAgence(item.agence || "") || (item.agence || "").toString().trim();
      const lieuPrecis = (item.lieu_precis || item.lieuPrecis || "").toString().trim();
      const statutTransfert =
        (item.statut_transfert || item.statut || "DISPONIBLE").toString().trim() || "DISPONIBLE";

      if (!nom && !prenoms && !numSecu && !numero) continue;

      if (numSecu) {
        const exist = await client.query(
          `SELECT id FROM cartes WHERE TRIM(num_secu) = $1 LIMIT 1`,
          [numSecu]
        );
        if (exist.rows.length > 0) {
          await client.query(
            `UPDATE cartes
             SET rangement = COALESCE(NULLIF($1, ''), rangement),
                 nom = COALESCE(NULLIF($2, ''), nom),
                 prenoms = COALESCE(NULLIF($3, ''), prenoms),
                 date_naissance = COALESCE(NULLIF($4, ''), date_naissance),
                 numero = COALESCE(NULLIF($5, ''), numero),
                 agence = COALESCE(NULLIF($6, ''), agence),
                 lieu_precis = COALESCE(NULLIF($7, ''), lieu_precis),
                 statut_transfert = COALESCE(NULLIF($8, ''), statut_transfert)
             WHERE id = $9`,
            [
              rangement,
              nom,
              prenoms,
              dateNaissance,
              numero,
              agence,
              lieuPrecis,
              statutTransfert,
              exist.rows[0].id
            ]
          );
          misesAJour++;
          continue;
        }
      }

      await client.query(
        `INSERT INTO cartes (
          rangement, num_secu, nom, prenoms, date_naissance, numero, agence, lieu_precis, statut_transfert
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          rangement,
          numSecu,
          nom,
          prenoms,
          dateNaissance,
          numero,
          agence,
          lieuPrecis,
          statutTransfert
        ]
      );
      inserees++;
    }

    await client.query("COMMIT");

    res.json({
      message: `Import terminé : ${inserees} carte(s) ajoutée(s), ${misesAJour} mise(s) à jour.`
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
      `SELECT id, rangement, num_secu, nom, prenoms, date_naissance, numero, agence, lieu_precis
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
      const agNorm = normaliserAgence(r.agence) || (r.agence || "").toString().trim();
      const lieu = (r.lieu_precis || "").toString().trim();
      const sousPref = normaliserTexte(lieu) || agNorm;
      const nomComplet = `${(r.nom || "").toString().trim()} ${(r.prenoms || "").toString().trim()}`.trim();
      const numSecu = (r.num_secu || "").toString().trim();
      const numero = (r.numero || "").toString().trim();
      const cleCarte = `${r.id}_${numSecu || numero || "SANS_NUM"}`;

      const rowVals = [
        cleCarte,
        r.id,
        numSecu,
        numero,
        nomComplet,
        formaterDateFR(r.date_naissance),
        (r.rangement || "").toString().trim(),
        agNorm,
        sousPref,
        lieu || agNorm
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
        (s.agence_retrait || "").toString().trim() ||
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
          `SELECT id, rangement, num_secu, nom, prenoms, date_naissance, numero, agence, lieu_precis
           FROM cartes WHERE id = $1 FOR UPDATE`,
          [Number(idCarteRaw)]
        );
        if (qId.rows.length > 0) carteRow = qId.rows[0];
      }

      if (!carteRow && numSecuRaw) {
        const qSecu = await client.query(
          `SELECT id, rangement, num_secu, nom, prenoms, date_naissance, numero, agence, lieu_precis
           FROM cartes WHERE TRIM(num_secu) = $1 FOR UPDATE LIMIT 1`,
          [numSecuRaw]
        );
        if (qSecu.rows.length > 0) carteRow = qSecu.rows[0];
      }

      if (!carteRow && numeroRaw) {
        const qNum = await client.query(
          `SELECT id, rangement, num_secu, nom, prenoms, date_naissance, numero, agence, lieu_precis
           FROM cartes WHERE TRIM(numero) = $1 FOR UPDATE LIMIT 1`,
          [numeroRaw]
        );
        if (qNum.rows.length > 0) carteRow = qNum.rows[0];
      }

      if (!carteRow) {
        const refVerif = numSecuRaw || numeroRaw;
        if (refVerif) {
          const qHist = await client.query(
            `SELECT id FROM historique WHERE TRIM(num_secu) = $1 OR TRIM(numero) = $1 LIMIT 1`,
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

      await client.query(
        `INSERT INTO historique (
          rangement, num_secu, nom, prenoms, date_naissance, numero, agence, lieu_precis,
          retire_par, telephone_retrait, date_retrait, agence_retrait
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          carteRow.rangement || "",
          formaterNumSecu(carteRow.num_secu, carteRow.numero),
          carteRow.nom || "",
          carteRow.prenoms || "",
          formaterDateFR(carteRow.date_naissance),
          carteRow.numero || "",
          carteRow.agence || "",
          carteRow.lieu_precis || "",
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

// --- 10. Chargement du stock terrain (par agence et localité exacte) ---
app.get("/api/terrain/cartes", async (req, res) => {
  try {
    const agenceFiltre = normaliserAgence(req.query.agence || "");
    const localiteFiltre = normaliserTexte(req.query.localite || "");

    const q = await pool.query(
      `SELECT id, rangement, num_secu, nom, prenoms, date_naissance, numero, agence, lieu_precis, statut_transfert
       FROM cartes
       ORDER BY nom ASC, prenoms ASC, id ASC`
    );

    const cartesFiltrees = [];

    for (const r of q.rows) {
      const agNorm = normaliserAgence(r.agence);
      const lieuBrut = (r.lieu_precis || "").toString().trim();
      const lieuNorm = normaliserTexte(lieuBrut);

      if (agenceFiltre && agNorm !== agenceFiltre) {
        continue;
      }

      if (localiteFiltre) {
        const correspondLocalite =
          lieuNorm === localiteFiltre ||
          (localiteFiltre === agNorm && lieuNorm === "");
        if (!correspondLocalite) {
          continue;
        }
      }

      cartesFiltrees.push({
        id: r.id,
        rangement: (r.rangement || "Non défini").toString().trim(),
        numSecu: formaterNumSecu(r.num_secu, r.numero),
        numSecuBrut: (r.num_secu || "").toString().trim(),
        numero: (r.numero || "").toString().trim(),
        nom: (r.nom || "").toString().trim(),
        prenoms: (r.prenoms || "").toString().trim(),
        dateNaissance: formaterDateFR(r.date_naissance),
        agence: agNorm || (r.agence || "").toString().trim(),
        lieuPrecis: lieuBrut || agNorm
      });
    }

    res.json({
      agence: agenceFiltre || "TOUTES",
      localite: localiteFiltre || "TOUTES",
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
        (item.agenceRetrait || "").toString().trim() || `${agCarte}-(${identifiantAgent})`;
      const dateRetrait =
        (item.dateRetrait || "").toString().trim() || formaterDateFR(new Date());

      if (!retirePar || !/^\d{10}$/.test(telFormate)) {
        erreurs++;
        continue;
      }

      let carteRow = null;

      if (Number.isInteger(idCarte) && idCarte > 0) {
        const qId = await client.query(
          `SELECT id, rangement, num_secu, nom, prenoms, date_naissance, numero, agence, lieu_precis
           FROM cartes WHERE id = $1 FOR UPDATE`,
          [idCarte]
        );
        if (qId.rows.length > 0) carteRow = qId.rows[0];
      }

      if (!carteRow && numSecu && numSecu !== "Non renseigné") {
        const qSecu = await client.query(
          `SELECT id, rangement, num_secu, nom, prenoms, date_naissance, numero, agence, lieu_precis
           FROM cartes WHERE TRIM(num_secu) = $1 FOR UPDATE LIMIT 1`,
          [numSecu]
        );
        if (qSecu.rows.length > 0) carteRow = qSecu.rows[0];
      }

      if (!carteRow && numero) {
        const qNum = await client.query(
          `SELECT id, rangement, num_secu, nom, prenoms, date_naissance, numero, agence, lieu_precis
           FROM cartes WHERE TRIM(numero) = $1 FOR UPDATE LIMIT 1`,
          [numero]
        );
        if (qNum.rows.length > 0) carteRow = qNum.rows[0];
      }

      if (!carteRow) {
        const refVerif = (numSecu && numSecu !== "Non renseigné" ? numSecu : "") || numero;
        if (refVerif) {
          const qHist = await client.query(
            `SELECT id FROM historique WHERE TRIM(num_secu) = $1 OR TRIM(numero) = $1 LIMIT 1`,
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

      await client.query(
        `INSERT INTO historique (
          rangement, num_secu, nom, prenoms, date_naissance, numero, agence, lieu_precis,
          retire_par, telephone_retrait, date_retrait, agence_retrait
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          carteRow.rangement || "",
          formaterNumSecu(carteRow.num_secu, carteRow.numero),
          carteRow.nom || "",
          carteRow.prenoms || "",
          formaterDateFR(carteRow.date_naissance),
          carteRow.numero || "",
          carteRow.agence || agCarte,
          carteRow.lieu_precis || "",
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
