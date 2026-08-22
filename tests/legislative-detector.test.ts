import { describe, it, expect } from "vitest";
import {
  isLegislativeReference,
  parseLegislativeReference,
  LegislativeMatch,
} from "../src/modules/utils/legislative-detector";

// ─── Detection: Romania (RO) ─────────────────────────────────────────

describe("isLegislativeReference — RO", () => {
  it("detects Legea nr.", () => {
    const m = isLegislativeReference("Legea nr. 95/2006 privind reforma în domeniul sănătății");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("RO");
    expect(m!.type).toBe("statute");
    expect(m!.subType).toBe("lege");
  });

  it("detects Lege nr. (alternate form)", () => {
    const m = isLegislativeReference("Lege nr. 10/2001");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("RO");
    expect(m!.subType).toBe("lege");
  });

  it("detects L. nr. abbreviation", () => {
    const m = isLegislativeReference("L. nr. 95/2006");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("RO");
    expect(m!.subType).toBe("lege");
  });

  it("detects OUG nr.", () => {
    const m = isLegislativeReference("OUG nr. 57/2019 privind Codul administrativ");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("RO");
    expect(m!.subType).toBe("oug");
  });

  it("detects Ordonanța de urgență", () => {
    const m = isLegislativeReference("Ordonanța de urgență nr. 57/2019");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("RO");
    expect(m!.subType).toBe("oug");
  });

  it("detects O.U.G. nr.", () => {
    const m = isLegislativeReference("O.U.G. nr. 34/2006");
    expect(m).not.toBeNull();
    expect(m!.subType).toBe("oug");
  });

  it("detects OG nr.", () => {
    const m = isLegislativeReference("OG nr. 2/2001 privind regimul juridic al contravențiilor");
    expect(m).not.toBeNull();
    expect(m!.subType).toBe("og");
  });

  it("detects Ordonanța Guvernului", () => {
    const m = isLegislativeReference("Ordonanța Guvernului nr. 2/2001");
    expect(m).not.toBeNull();
    expect(m!.subType).toBe("og");
  });

  it("detects O.G. nr.", () => {
    const m = isLegislativeReference("O.G. nr. 2/2001");
    expect(m).not.toBeNull();
    expect(m!.subType).toBe("og");
  });

  it("detects HG nr.", () => {
    const m = isLegislativeReference("HG nr. 1425/2006 pentru aprobarea Normelor metodologice");
    expect(m).not.toBeNull();
    expect(m!.subType).toBe("hg");
  });

  it("detects Hotărârea Guvernului", () => {
    const m = isLegislativeReference("Hotărârea Guvernului nr. 1425/2006");
    expect(m).not.toBeNull();
    expect(m!.subType).toBe("hg");
  });

  it("detects H.G. nr.", () => {
    const m = isLegislativeReference("H.G. nr. 1425/2006");
    expect(m).not.toBeNull();
    expect(m!.subType).toBe("hg");
  });

  it("detects Hotararea Guvernului without diacritics", () => {
    const m = isLegislativeReference("Hotararea Guvernului nr. 1425/2006");
    expect(m).not.toBeNull();
    expect(m!.subType).toBe("hg");
  });

  it("detects Ordinul ministrului", () => {
    const m = isLegislativeReference("Ordinul ministrului sănătății nr. 1226/2012");
    expect(m).not.toBeNull();
    expect(m!.subType).toBe("ordin");
  });

  it("detects Ordin nr.", () => {
    const m = isLegislativeReference("Ordin nr. 1226/2012");
    expect(m).not.toBeNull();
    expect(m!.subType).toBe("ordin");
  });

  it("detects Codul civil", () => {
    const m = isLegislativeReference("Codul civil");
    expect(m).not.toBeNull();
    expect(m!.subType).toBe("cod");
  });

  it("detects Codul penal", () => {
    const m = isLegislativeReference("Codul penal");
    expect(m).not.toBeNull();
    expect(m!.subType).toBe("cod");
  });

  it("detects Codul fiscal", () => {
    const m = isLegislativeReference("Codul fiscal");
    expect(m).not.toBeNull();
    expect(m!.subType).toBe("cod");
  });

  it("detects Codul muncii", () => {
    const m = isLegislativeReference("Codul muncii");
    expect(m).not.toBeNull();
    expect(m!.subType).toBe("cod");
  });

  it("detects Codul de procedură civilă", () => {
    const m = isLegislativeReference("Codul de procedură civilă");
    expect(m).not.toBeNull();
    expect(m!.subType).toBe("cod");
  });

  it("detects Codul administrativ", () => {
    const m = isLegislativeReference("Codul administrativ");
    expect(m).not.toBeNull();
    expect(m!.subType).toBe("cod");
  });

  it("detects Codul silvic", () => {
    const m = isLegislativeReference("Codul silvic");
    expect(m).not.toBeNull();
    expect(m!.subType).toBe("cod");
  });

  it("detects Codul aerian", () => {
    const m = isLegislativeReference("Codul aerian");
    expect(m).not.toBeNull();
    expect(m!.subType).toBe("cod");
  });

  it("detects Constituția României", () => {
    const m = isLegislativeReference("Constituția României");
    expect(m).not.toBeNull();
    expect(m!.subType).toBe("constitutie");
  });

  it("detects Constituția (standalone)", () => {
    const m = isLegislativeReference("Constituția");
    expect(m).not.toBeNull();
    expect(m!.subType).toBe("constitutie");
  });

  it("detects Decizia CCR", () => {
    const m = isLegislativeReference("Decizia CCR nr. 685/2018");
    expect(m).not.toBeNull();
    expect(m!.subType).toBe("decizie");
  });

  it("detects Decizia Curții Constituționale", () => {
    const m = isLegislativeReference("Decizia Curții Constituționale nr. 685/2018");
    expect(m).not.toBeNull();
    expect(m!.subType).toBe("decizie");
  });

  it("detects Decizia ÎCCJ", () => {
    const m = isLegislativeReference("Decizia ÎCCJ nr. 12/2020");
    expect(m).not.toBeNull();
    expect(m!.subType).toBe("decizie");
  });

  it("detects Decret nr.", () => {
    const m = isLegislativeReference("Decret nr. 195/2020");
    expect(m).not.toBeNull();
    expect(m!.subType).toBe("decret");
  });

  it("detects Decret-lege nr.", () => {
    const m = isLegislativeReference("Decret-lege nr. 118/1990");
    expect(m).not.toBeNull();
    expect(m!.subType).toBe("decret-lege");
  });

  it("detects Normă metodologică", () => {
    const m = isLegislativeReference("Normă metodologică de aplicare a Legii nr. 95/2006");
    expect(m).not.toBeNull();
    expect(m!.subType).toBe("norma");
  });

  it("detects Norme metodologice", () => {
    const m = isLegislativeReference("Norme metodologice de aplicare");
    expect(m).not.toBeNull();
    expect(m!.subType).toBe("norma");
  });

  it("detects Instrucțiune nr.", () => {
    const m = isLegislativeReference("Instrucțiune nr. 1/2020");
    expect(m).not.toBeNull();
    expect(m!.subType).toBe("instructiune");
  });

  it("detects Metodologie", () => {
    const m = isLegislativeReference("Metodologie privind organizarea și desfășurarea admiterii");
    expect(m).not.toBeNull();
    expect(m!.subType).toBe("metodologie");
  });

  it("detects Dispoziție", () => {
    const m = isLegislativeReference("Dispoziție nr. 5/2021");
    expect(m).not.toBeNull();
    expect(m!.subType).toBe("dispozitie");
  });

  it("detects without diacritics: Ordonanta de urgenta", () => {
    const m = isLegislativeReference("Ordonanta de urgenta nr. 57/2019");
    expect(m).not.toBeNull();
    expect(m!.subType).toBe("oug");
  });
});

// ─── Detection: EU ───────────────────────────────────────────────────

describe("isLegislativeReference — EU", () => {
  it("detects Regulation (EU)", () => {
    const m = isLegislativeReference("Regulation (EU) 2016/679 on data protection (GDPR)");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("EU");
    expect(m!.subType).toBe("regulation");
  });

  it("detects Regulation (EC)", () => {
    const m = isLegislativeReference("Regulation (EC) No 1907/2006 (REACH)");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("EU");
    expect(m!.subType).toBe("regulation");
  });

  it("detects Regulation (EEC)", () => {
    const m = isLegislativeReference("Council Regulation (EEC) No 2913/92");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("EU");
    expect(m!.subType).toBe("regulation");
  });

  it("detects Implementing Regulation", () => {
    const m = isLegislativeReference("Commission Implementing Regulation (EU) 2020/1201");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("EU");
    expect(m!.subType).toBe("regulation");
  });

  it("detects Delegated Regulation", () => {
    const m = isLegislativeReference("Commission Delegated Regulation (EU) 2019/945");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("EU");
    expect(m!.subType).toBe("regulation");
  });

  it("detects Directive (EU)", () => {
    const m = isLegislativeReference("Directive (EU) 2019/790 on copyright in the Digital Single Market");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("EU");
    expect(m!.subType).toBe("directive");
  });

  it("detects Directive YYYY/", () => {
    const m = isLegislativeReference("Directive 2006/123/EC on services in the internal market");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("EU");
    expect(m!.subType).toBe("directive");
  });

  it("detects Framework Decision", () => {
    const m = isLegislativeReference("Framework Decision 2002/584/JHA on the European arrest warrant");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("EU");
    expect(m!.subType).toBe("decision");
  });

  it("detects Decision (EU)", () => {
    const m = isLegislativeReference("Decision (EU) 2020/135");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("EU");
    expect(m!.subType).toBe("decision");
  });

  it("detects French EU: Règlement (UE)", () => {
    const m = isLegislativeReference("Règlement (UE) 2016/679");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("EU");
    expect(m!.subType).toBe("regulation");
  });

  it("detects German EU: Verordnung (EU)", () => {
    const m = isLegislativeReference("Verordnung (EU) 2016/679");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("EU");
    expect(m!.subType).toBe("regulation");
  });
});

// ─── Detection: English/Common Law (EN) ──────────────────────────────

describe("isLegislativeReference — EN", () => {
  it("detects [Name] Act YYYY", () => {
    const m = isLegislativeReference("Data Protection Act 2018");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("EN");
    expect(m!.subType).toBe("act");
  });

  it("detects multi-word Act name", () => {
    const m = isLegislativeReference("National Health Service Act 2006");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("EN");
    expect(m!.subType).toBe("act");
  });

  it("detects Public Law", () => {
    const m = isLegislativeReference("Public Law 111-148 Patient Protection and Affordable Care Act");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("EN");
    expect(m!.subType).toBe("public_law");
  });

  it("detects Pub. L.", () => {
    const m = isLegislativeReference("Pub. L. 111-148");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("EN");
    expect(m!.subType).toBe("public_law");
  });

  it("detects P.L.", () => {
    const m = isLegislativeReference("P.L. 111-148");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("EN");
    expect(m!.subType).toBe("public_law");
  });

  it("detects Executive Order", () => {
    const m = isLegislativeReference("Executive Order 13769");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("EN");
    expect(m!.subType).toBe("executive_order");
  });

  it("detects Statutory Instrument", () => {
    const m = isLegislativeReference("Statutory Instrument 2020 No. 350");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("EN");
    expect(m!.subType).toBe("statutory_instrument");
  });

  it("does NOT match 'act' as a verb (no year)", () => {
    const m = isLegislativeReference("Neurons act through synaptic transmission");
    expect(m).toBeNull();
  });

  it("does NOT match lowercase act with year", () => {
    const m = isLegislativeReference("proteins that act during 2019 experiments");
    expect(m).toBeNull();
  });
});

// ─── Detection: French (FR) ──────────────────────────────────────────

describe("isLegislativeReference — FR", () => {
  it("detects Loi n°", () => {
    const m = isLegislativeReference("Loi n° 2016-1691 du 9 décembre 2016 relative à la transparence");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("FR");
    expect(m!.subType).toBe("loi");
  });

  it("detects Décret n°", () => {
    const m = isLegislativeReference("Décret n° 2020-1310 du 29 octobre 2020");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("FR");
    expect(m!.subType).toBe("decret");
  });

  it("detects Arrêté du", () => {
    const m = isLegislativeReference("Arrêté du 1er mars 2020");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("FR");
    expect(m!.subType).toBe("arrete");
  });

  it("detects Arrêté ministériel", () => {
    const m = isLegislativeReference("Arrêté ministériel du 15 janvier 2021");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("FR");
    expect(m!.subType).toBe("arrete");
  });

  it("detects Ordonnance n°", () => {
    const m = isLegislativeReference("Ordonnance n° 2020-304 du 25 mars 2020");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("FR");
    expect(m!.subType).toBe("ordonnance");
  });

  it("detects Circulaire du", () => {
    const m = isLegislativeReference("Circulaire du 12 avril 2021");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("FR");
    expect(m!.subType).toBe("circulaire");
  });

  it("detects Code civil (French)", () => {
    const m = isLegislativeReference("Code civil");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("FR");
    expect(m!.subType).toBe("code");
  });

  it("detects Code pénal (French)", () => {
    const m = isLegislativeReference("Code pénal");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("FR");
    expect(m!.subType).toBe("code");
  });

  it("detects Code du travail", () => {
    const m = isLegislativeReference("Code du travail");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("FR");
    expect(m!.subType).toBe("code");
  });

  it("detects Code de commerce", () => {
    const m = isLegislativeReference("Code de commerce");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("FR");
    expect(m!.subType).toBe("code");
  });

  it("detects Code de la santé", () => {
    const m = isLegislativeReference("Code de la santé publique");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("FR");
    expect(m!.subType).toBe("code");
  });

  it("detects Code de l'environnement", () => {
    const m = isLegislativeReference("Code de l'environnement");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("FR");
    expect(m!.subType).toBe("code");
  });

  it("detects Code de l'éducation", () => {
    const m = isLegislativeReference("Code de l'éducation");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("FR");
    expect(m!.subType).toBe("code");
  });
});

// ─── Detection: German (DE) ──────────────────────────────────────────

describe("isLegislativeReference — DE", () => {
  it("detects Grundgesetz", () => {
    const m = isLegislativeReference("Grundgesetz für die Bundesrepublik Deutschland");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("DE");
    expect(m!.subType).toBe("grundgesetz");
  });

  it("detects word ending in gesetz (Strafgesetzbuch)", () => {
    const m = isLegislativeReference("Strafgesetzbuch");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("DE");
    expect(m!.subType).toBe("gesetz");
  });

  it("detects word ending in gesetz (Bundesgesetz)", () => {
    const m = isLegislativeReference("Bundesgesetz über den Datenschutz");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("DE");
    expect(m!.subType).toBe("gesetz");
  });

  it("detects Verordnung (non-EU)", () => {
    const m = isLegislativeReference("Verordnung über die ärztliche Berufsausübung");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("DE");
    expect(m!.subType).toBe("verordnung");
  });

  it("does NOT detect Verordnung (EU) as DE — should be EU", () => {
    const m = isLegislativeReference("Verordnung (EU) 2016/679");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("EU");
  });

  it("detects Richtlinie (non-EU)", () => {
    const m = isLegislativeReference("Richtlinie für die Vergabe von Studienplätzen");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("DE");
    expect(m!.subType).toBe("richtlinie");
  });

  it("does NOT detect Richtlinie (EU) as DE — should be EU", () => {
    const m = isLegislativeReference("Richtlinie (EU) 2019/790");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("EU");
  });

  it("detects Beschluss", () => {
    const m = isLegislativeReference("Beschluss des Bundesverfassungsgerichts");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("DE");
    expect(m!.subType).toBe("beschluss");
  });

  it("detects Erlass", () => {
    const m = isLegislativeReference("Erlass über die Schulorganisation");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("DE");
    expect(m!.subType).toBe("erlass");
  });

  it("detects Satzung", () => {
    const m = isLegislativeReference("Satzung der Universität München");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("DE");
    expect(m!.subType).toBe("satzung");
  });
});

// ─── Detection: International (INT) ──────────────────────────────────

describe("isLegislativeReference — INT", () => {
  it("detects Treaty of", () => {
    const m = isLegislativeReference("Treaty of Lisbon amending the Treaty on European Union");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("INT");
    expect(m!.subType).toBe("treaty");
  });

  it("detects Treaty on", () => {
    const m = isLegislativeReference("Treaty on the Functioning of the European Union");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("INT");
    expect(m!.subType).toBe("treaty");
  });

  it("detects Convention on", () => {
    const m = isLegislativeReference("Convention on the Rights of the Child");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("INT");
    expect(m!.subType).toBe("convention");
  });

  it("detects Convention for", () => {
    const m = isLegislativeReference("Convention for the Protection of Human Rights");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("INT");
    expect(m!.subType).toBe("convention");
  });

  it("detects Convention against", () => {
    const m = isLegislativeReference("Convention against Torture");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("INT");
    expect(m!.subType).toBe("convention");
  });

  it("detects Convention relating", () => {
    const m = isLegislativeReference("Convention relating to the Status of Refugees");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("INT");
    expect(m!.subType).toBe("convention");
  });

  it("detects Protocol to", () => {
    const m = isLegislativeReference("Protocol to the Convention on Human Rights");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("INT");
    expect(m!.subType).toBe("protocol");
  });

  it("detects Protocol on", () => {
    const m = isLegislativeReference("Protocol on the Privileges and Immunities");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("INT");
    expect(m!.subType).toBe("protocol");
  });

  it("detects Additional Protocol", () => {
    const m = isLegislativeReference("Additional Protocol to the European Social Charter");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("INT");
    expect(m!.subType).toBe("protocol");
  });

  it("detects Covenant on", () => {
    const m = isLegislativeReference("International Covenant on Civil and Political Rights");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("INT");
    expect(m!.subType).toBe("covenant");
  });

  it("detects Charter of", () => {
    const m = isLegislativeReference("Charter of the United Nations");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("INT");
    expect(m!.subType).toBe("charter");
  });

  it("detects Charter on", () => {
    const m = isLegislativeReference("Charter on Fundamental Rights of the European Union");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("INT");
    expect(m!.subType).toBe("charter");
  });

  it("detects Universal Declaration", () => {
    const m = isLegislativeReference("Universal Declaration of Human Rights");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("INT");
    expect(m!.subType).toBe("declaration");
  });

  it("detects Rome Statute", () => {
    const m = isLegislativeReference("Rome Statute of the International Criminal Court");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("INT");
    expect(m!.subType).toBe("statute");
  });

  it("detects Geneva Statute", () => {
    const m = isLegislativeReference("Geneva Convention relative to the Treatment of Prisoners of War");
    // This should match as convention, not statute
    const m2 = isLegislativeReference("Geneva Statute");
    expect(m2).not.toBeNull();
    expect(m2!.jurisdiction).toBe("INT");
  });

  it("detects Hague Statute", () => {
    const m = isLegislativeReference("Hague Statute");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("INT");
  });

  it("detects Vienna Statute", () => {
    const m = isLegislativeReference("Vienna Statute");
    expect(m).not.toBeNull();
    expect(m!.jurisdiction).toBe("INT");
  });
});

// ─── Negative test cases (MUST NOT match) ────────────────────────────

describe("isLegislativeReference — negative cases", () => {
  it("does NOT match normal medical article", () => {
    expect(isLegislativeReference("Blood biomarkers for traumatic brain injury")).toBeNull();
  });

  it("does NOT match article mentioning 'law' generally", () => {
    expect(isLegislativeReference("Impact of health law reform on patient outcomes")).toBeNull();
  });

  it("does NOT match 'regulation' in biology context", () => {
    expect(isLegislativeReference("A review of gene regulation mechanisms in cancer")).toBeNull();
  });

  it("does NOT match 'act' as verb without year", () => {
    expect(isLegislativeReference("Neurons act through synaptic transmission")).toBeNull();
  });

  it("does NOT match random scientific title with numbers", () => {
    expect(isLegislativeReference("Analysis of 2019 COVID-19 pandemic data")).toBeNull();
  });

  it("does NOT match general conference/convention without preposition", () => {
    expect(isLegislativeReference("IEEE Convention 2023 proceedings")).toBeNull();
  });

  it("does NOT match 'protocol' in medical context", () => {
    expect(isLegislativeReference("A clinical protocol for managing sepsis")).toBeNull();
  });

  it("does NOT match 'charter school' context", () => {
    expect(isLegislativeReference("Performance of charter schools in urban districts")).toBeNull();
  });
});

// ─── Parsing: RO ─────────────────────────────────────────────────────

describe("parseLegislativeReference — RO", () => {
  it("parses Legea nr. X/YYYY", () => {
    const title = "Legea nr. 95/2006 privind reforma în domeniul sănătății";
    const match = isLegislativeReference(title)!;
    const fields = parseLegislativeReference(title, match);
    expect(fields.itemType).toBe("statute");
    expect(fields.codeNumber).toBe("95/2006");
    expect(fields.code).toBe("Monitorul Oficial");
    expect(fields.authority).toBe("Parlamentul României");
    expect(fields.jurisdiction).toBe("România");
    expect(fields.title).toBe(title);
  });

  it("parses OUG nr. X/YYYY", () => {
    const title = "OUG nr. 57/2019 privind Codul administrativ";
    const match = isLegislativeReference(title)!;
    const fields = parseLegislativeReference(title, match);
    expect(fields.codeNumber).toBe("57/2019");
    expect(fields.authority).toBe("Guvernul României");
  });

  it("parses HG nr. X/YYYY", () => {
    const title = "HG nr. 1425/2006 pentru aprobarea Normelor metodologice";
    const match = isLegislativeReference(title)!;
    const fields = parseLegislativeReference(title, match);
    expect(fields.codeNumber).toBe("1425/2006");
    expect(fields.authority).toBe("Guvernul României");
  });

  it("parses Codul civil (no number)", () => {
    const title = "Codul civil";
    const match = isLegislativeReference(title)!;
    const fields = parseLegislativeReference(title, match);
    expect(fields.codeNumber).toBe("");
    expect(fields.authority).toBe("Parlamentul României");
  });

  it("parses Constituția", () => {
    const title = "Constituția României";
    const match = isLegislativeReference(title)!;
    const fields = parseLegislativeReference(title, match);
    expect(fields.codeNumber).toBe("");
    expect(fields.authority).toBe("Parlamentul României");
    expect(fields.code).toBe("Monitorul Oficial");
  });

  it("parses Decizia CCR nr. X/YYYY", () => {
    const title = "Decizia CCR nr. 685/2018";
    const match = isLegislativeReference(title)!;
    const fields = parseLegislativeReference(title, match);
    expect(fields.codeNumber).toBe("685/2018");
    expect(fields.authority).toBe("Curtea Constituțională a României");
  });

  it("extracts year for dateEnacted from nr. X/YYYY", () => {
    const title = "Legea nr. 95/2006 privind reforma";
    const match = isLegislativeReference(title)!;
    const fields = parseLegislativeReference(title, match);
    expect(fields.dateEnacted).toBe("2006");
  });
});

// ─── Parsing: EU ─────────────────────────────────────────────────────

describe("parseLegislativeReference — EU", () => {
  it("parses Regulation (EU) YYYY/NNN", () => {
    const title = "Regulation (EU) 2016/679 on data protection (GDPR)";
    const match = isLegislativeReference(title)!;
    const fields = parseLegislativeReference(title, match);
    expect(fields.codeNumber).toBe("2016/679");
    expect(fields.code).toBe("OJ");
    expect(fields.authority).toBe("European Union");
    expect(fields.jurisdiction).toBe("EU");
  });

  it("parses Directive YYYY/NNN/EC", () => {
    const title = "Directive 2006/123/EC on services in the internal market";
    const match = isLegislativeReference(title)!;
    const fields = parseLegislativeReference(title, match);
    expect(fields.codeNumber).toBe("2006/123");
  });

  it("parses Framework Decision YYYY/NNN/JHA", () => {
    const title = "Framework Decision 2002/584/JHA on the European arrest warrant";
    const match = isLegislativeReference(title)!;
    const fields = parseLegislativeReference(title, match);
    expect(fields.codeNumber).toBe("2002/584");
  });
});

// ─── Parsing: FR ─────────────────────────────────────────────────────

describe("parseLegislativeReference — FR", () => {
  it("parses Loi n° YYYY-NNN", () => {
    const title = "Loi n° 2016-1691 du 9 décembre 2016 relative à la transparence";
    const match = isLegislativeReference(title)!;
    const fields = parseLegislativeReference(title, match);
    expect(fields.codeNumber).toBe("2016-1691");
    expect(fields.code).toBe("Journal officiel");
    expect(fields.authority).toBe("République française");
    expect(fields.jurisdiction).toBe("France");
  });

  it("extracts dateEnacted from 'du DATE'", () => {
    const title = "Décret n° 2020-1310 du 29 octobre 2020";
    const match = isLegislativeReference(title)!;
    const fields = parseLegislativeReference(title, match);
    expect(fields.dateEnacted).toBe("29 octobre 2020");
  });

  it("parses Code civil (French)", () => {
    const title = "Code civil";
    const match = isLegislativeReference(title)!;
    const fields = parseLegislativeReference(title, match);
    expect(fields.jurisdiction).toBe("France");
    expect(fields.codeNumber).toBe("");
  });
});

// ─── Parsing: EN ─────────────────────────────────────────────────────

describe("parseLegislativeReference — EN", () => {
  it("parses Act YYYY", () => {
    const title = "Data Protection Act 2018";
    const match = isLegislativeReference(title)!;
    const fields = parseLegislativeReference(title, match);
    expect(fields.codeNumber).toBe("");
    expect(fields.dateEnacted).toBe("2018");
  });

  it("parses Pub. L. NNN-NNN", () => {
    const title = "Pub. L. 111-148";
    const match = isLegislativeReference(title)!;
    const fields = parseLegislativeReference(title, match);
    expect(fields.codeNumber).toBe("111-148");
  });

  it("parses Executive Order NNNNN", () => {
    const title = "Executive Order 13769";
    const match = isLegislativeReference(title)!;
    const fields = parseLegislativeReference(title, match);
    expect(fields.codeNumber).toBe("13769");
  });
});

// ─── Parsing: DE & INT ───────────────────────────────────────────────

describe("parseLegislativeReference — DE & INT", () => {
  it("parses Grundgesetz", () => {
    const title = "Grundgesetz für die Bundesrepublik Deutschland";
    const match = isLegislativeReference(title)!;
    const fields = parseLegislativeReference(title, match);
    expect(fields.jurisdiction).toBe("Deutschland");
    expect(fields.authority).toBe("Bundesrepublik Deutschland");
  });

  it("parses international treaty", () => {
    const title = "Treaty of Lisbon amending the Treaty on European Union";
    const match = isLegislativeReference(title)!;
    const fields = parseLegislativeReference(title, match);
    expect(fields.jurisdiction).toBe("International");
    expect(fields.authority).toBe("International");
  });

  it("parses Universal Declaration", () => {
    const title = "Universal Declaration of Human Rights";
    const match = isLegislativeReference(title)!;
    const fields = parseLegislativeReference(title, match);
    expect(fields.jurisdiction).toBe("International");
  });
});
