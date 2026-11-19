require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

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
  if (norm === "BK" || norm === "BIANKOUMA") return "BIANKOUMA";
  if (norm === "DAN" || norm === "DANANE" || norm === "DANANE") return "DANANE";
  if (norm === "MAN") return "MAN";
  if (norm === "SIP" || norm === "SIPILOU") return "SIPILOU";
  if (norm === "ZH" || norm === "ZOUAN-HOUNIEN" || norm === "ZOUAN HOUNIEN" || norm === "ZOUAN-HOUN") {
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
    if (up.indexOf("VERS " + depts[i]) !== -1) {
      return normaliserAgence(depts[i]);
    }
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

// --- Route de santé ---
app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "CMU FINDER TONKPI API" });
});

// --- 1. Connexion (3 tentatives + suspension) ---
app.post("/api/login", async (req, res) => {
  try {
    const idRecherche = req.body.identifiant ? normaliserTexte(req.body.identifiant) : "";
    const passRecherche = req.body.password ? req.body.password.toString().trim() : "";

    if (!idRecherche || !passRecherche) {
      return res.json({
        success: false,
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

    if (etatSecu === "SUSPENDU") {
      return res.json({
        success: false,
        suspendu: true,
        tentativesRestantes: 0,
        message: "Compte suspendu après 3 tentatives infructueuses. Veuillez contacter le support pour débloquer le compte."
      });
    }

    if (dbPass === passRecherche) {
      if (etatSecu !== "") {
        await pool.query(`UPDATE utilisateurs SET tentatives_suspension = '' WHERE id = $1`, [user.id]);
      }
      const agenceEffective = dbAgence || normaliserAgence(user.identifiant);
      return res.json({
        success: true,
        nomComplet: dbNom || user.identifiant,
        agence: agenceEffective,
        agenceNorm: normaliserAgence(agenceEffective),
        role: dbRole,
        whatsapp: formaterTelephone10(user.numero)
      });
    }

    let echecsActuels = 0;
    if (etatSecu.indexOf("ECHEC_") === 0) {
      echecsActuels = parseInt(etatSecu.replace("ECHEC_", ""), 10) || 0;
    }
    echecsActuels++;

    if (echecsActuels >= 3) {
      await pool.query(`UPDATE utilisateurs SET tentatives_suspension = 'SUSPENDU' WHERE id = $1`, [user.id]);
      return res.json({
        success: false,
        suspendu: true,
        tentativesRestantes: 0,
        message: "Mot de passe incorrect. Tentatives restantes : 0. Compte suspendu, contactez le support."
      });
    } else {
      await pool.query(`UPDATE utilisateurs SET tentatives_suspension = $1 WHERE id = $2`, [
        "ECHEC_" + echecsActuels,
        user.id
      ]);
      const restantes = 3 - echecsActuels;
      return res.json({
        success: false,
        suspendu: false,
        tentativesRestantes: restantes,
        message: `Mot de passe incorrect. Tentative(s) restante(s) : ${restantes} sur 3.`
      });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: "Erreur serveur : " + err.message });
  }
});

// --- 2. Recherche rapide (priorité NUM_SECU exact, puis partiel, puis historique) ---
app.get("/api/cartes/recherche", async (req, res) => {
  try {
    const raw = (req.query.q || "").toString().trim();
    const terme = raw.toLowerCase();
    if (terme.length < 2) return res.json([]);

    const limite = 40;
    const likeTerm = `%${terme}%`;

    // 1) Correspondance exacte sur num_secu ou numero en priorité
    const exactRes = await pool.query(
      `SELECT id, rangement, num_secu, nom, prenoms, date_naissance, numero, agence, lieu_precis, statut_transfert
       FROM cartes
       WHERE LOWER(TRIM(COALESCE(num_secu, ''))) = $1
          OR LOWER(TRIM(COALESCE(numero, ''))) = $1
       LIMIT $2`,
      [terme, limite]
    );

    let rowsCartes = exactRes.rows;

    // 2) Complément par recherche partielle si besoin
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

    if (rowsCartes.length > 0) {
      const formatted = rowsCartes.map((r) => {
        const agence = (r.agence || "Non définie").toString().trim();
        return {
          ligneIndex: r.id, // Identifiant unique SQL de la carte
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
      return res.json(formatted);
    }

    // 3) Repli sur l'historique uniquement si aucune carte active ne correspond
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
      [likeTerm, limite]
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

    return res.json(formattedHist);
  } catch (err) {
    res.status(500).json({ error: "Erreur recherche : " + err.message });
  }
});

// --- 3. Statistiques de stock et réacheminements actifs ---
app.get("/api/stats", async (req, res) => {
  try {
    const agenceAgent = req.query.agence || "";
    const roleAgent = req.query.role || "AGENT";

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

    const roleNorm = normaliserTexte(roleAgent);
    const agenceAgentNorm = normaliserAgence(agenceAgent);
    const estSuperviseur =
      roleNorm === "SUPERVISEUR" ||
      roleNorm === "PATRON" ||
      roleNorm === "CHEF D'EQUIPE" ||
      roleNorm === "CHEF_EQUIPE" ||
      roleNorm === "CHEF EQUIPE" ||
      agenceAgentNorm === "REGIONAL";

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

      const concerneAgent =
        estSuperviseur ||
        (agenceDemandeur && agenceDemandeur === agenceAgentNorm) ||
        (agenceCarteNorm && agenceCarteNorm === agenceAgentNorm);

      if (concerneAgent) {
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

// --- 4a. Étape 1 : Demander un réacheminement ---
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
    const agenceDetentrice = (carte.agence || "").toString().trim();
    const nouveauStatut = `DEMANDE DE REACHEMINEMENT VERS ${demandeurNorm} (DEPUIS ${normaliserAgence(agenceDetentrice)})`;

    await pool.query(`UPDATE cartes SET statut_transfert = $1 WHERE id = $2`, [nouveauStatut, idCarte]);

    const numSecu = formaterNumSecu(carte.num_secu, carte.numero);
    const rangement = (carte.rangement || "Non défini").toString().trim();
    const nom = (carte.nom || "").toString().trim();
    const prenoms = (carte.prenoms || "").toString().trim();
    const dateNais = formaterDateFR(carte.date_naissance);

    const telDestinataire = await trouverContactWhatsappAgence(agenceDetentrice);
    const messageWhatsapp =
      `Bonjour cher responsable (${agenceDetentrice}),\n` +
      `Une demande de réacheminement a été émise par l'agence de ${demandeurNorm} pour la carte CMU suivante :\n` +
      `- N° Sécu : ${numSecu}\n` +
      `- Rangement : ${rangement}\n` +
      `- Nom & Prénoms : ${nom} ${prenoms}\n` +
      `- Date de naissance : ${dateNais || "Non renseignée"}\n` +
      `Merci de procéder au transfert et de valider l'envoi dans CMU FINDER TONKPI.`;

    const lienWhatsapp = telDestinataire
      ? `https://wa.me/${telDestinataire}?text=${encodeURIComponent(messageWhatsapp)}`
      : `https://wa.me/?text=${encodeURIComponent(messageWhatsapp)}`;

    res.json({
      success: true,
      message: `Demande de réacheminement enregistrée vers ${demandeurNorm}.`,
      lienWhatsapp,
      messageWhatsapp
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Erreur : " + err.message });
  }
});

// --- 4b. Étape 2 : Valider l'expédition ---
app.post("/api/reacheminement/expedier", async (req, res) => {
  try {
    const idCarte = Number(req.body.ligneIndex);
    const q = await pool.query(`SELECT statut_transfert FROM cartes WHERE id = $1 LIMIT 1`, [idCarte]);
    if (q.rows.length === 0) {
      return res.status(404).json({ message: "Carte introuvable." });
    }

    const cible = req.body.agenceDemandeurCible
      ? normaliserAgence(req.body.agenceDemandeurCible)
      : extraireAgenceDemandeur(q.rows[0].statut_transfert);

    const nouveauStatut = `Réacheminement en cours vers ${cible}`;
    await pool.query(`UPDATE cartes SET statut_transfert = $1 WHERE id = $2`, [nouveauStatut, idCarte]);

    res.json({ message: `Statut mis à jour : ${nouveauStatut}.` });
  } catch (err) {
    res.status(500).json({ message: "Erreur : " + err.message });
  }
});

// --- 4c. Étape 3 : Valider la réception ---
app.post("/api/reacheminement/recevoir", async (req, res) => {
  try {
    const idCarte = Number(req.body.ligneIndex);
    const agenceFinale = normaliserAgence(req.body.nouvelleAgence);

    await pool.query(
      `UPDATE cartes SET agence = $1, statut_transfert = 'Carte réacheminée' WHERE id = $2`,
      [agenceFinale, idCarte]
    );

    res.json({
      message: `Succès : Carte réceptionnée, rattachée à ${agenceFinale} et marquée 'Carte réacheminée'.`
    });
  } catch (err) {
    res.status(500).json({ message: "Erreur : " + err.message });
  }
});

// --- 5. Retrait en transaction SQL (préserve le 0 initial) ---
app.post("/api/cartes/retirer", async (req, res) => {
  const client = await pool.connect();
  try {
    const idCarte = Number(req.body.ligneIndex);
    const retirePar = (req.body.retirePar || "").toString().trim();
    const telFormate = formaterTelephone10(req.body.telephoneRetrait);
    const agenceRetrait = normaliserAgence(req.body.agenceAgent);

    if (!retirePar || !/^\d{10}$/.test(telFormate)) {
      return res.status(400).json({ message: "Nom/prénoms ou contact à 10 chiffres invalide." });
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
        telFormate, // VARCHAR : le '0' initial est conservé intact
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

app.listen(PORT, () => {
  console.log(`API CMU FINDER TONKPI démarrée sur le port ${PORT}`);
});