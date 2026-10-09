// Content of the development seed (spec 91 to 94).
//
// Everything here is PLACEHOLDER content that only bootstraps development.
// Researchers must replace and approve every participant-facing text before
// real data collection.
//
// Wording rule: a text that a participant can see reads as neutral study text.
// It never names the specification and never uses internal words. Where such a
// text must be replaced, it carries the sentence EXAMPLE_TEXT_NOTICE, which is
// acceptable if a participant sees it. The marker "[PLACEHOLDER]" is used only
// in fields a participant never sees (the protocol description, internal task
// names, researcher notes). Questionnaire names and descriptions are shown to
// participants, so they carry no marker at all.
//
// Language note: the text columns hold the English base text, and the column
// translations_json holds the Finnish text (packages/domain/src/localization.ts).
// A participant sees the texts in the language chosen on the welcome page. The
// fixed participant interface (buttons, labels) is translated by the web app
// dictionaries. The Finnish texts must be checked by a native speaker.
//
// The model identifiers below are the suggested defaults of spec 25. They are
// stored in the database by the seed and must not appear anywhere else in code.
import {
  ENGLISH_CHECK_DEFAULT_ENABLED,
  OUTPUT_REVIEW_DEFAULT_MAX_ITEMS,
  protocolSchemas,
  type ConsentTranslations,
  type FollowupTranslations,
  type ProtocolTranslations,
  type QuestionnaireItemTranslations,
} from "@dialect/domain";
import type { ConsentItem, ProtocolOrderConfig, StudySettings } from "../json-types";
import type { protocolTasks, questionnaireItems } from "../schema";

// Shown to participants at the top of every seeded study text. Searching the
// study texts for this sentence finds what the researchers still have to replace.
// The markers are defined once in @dialect/domain, because the publish check and
// the research session guard search for the same strings.
export const EXAMPLE_TEXT_NOTICE = protocolSchemas.EXAMPLE_TEXT_NOTICE;
const EXAMPLE_TEXT_PREFIX = protocolSchemas.EXAMPLE_TEXT_PREFIX;
const EXAMPLE_TEXT_NOTICE_FI = protocolSchemas.EXAMPLE_TEXT_NOTICE_FI;
const EXAMPLE_TEXT_PREFIX_FI = protocolSchemas.EXAMPLE_TEXT_PREFIX_FI;
// Used only in fields a participant never sees.
const ADMIN_PLACEHOLDER = `${protocolSchemas.ADMIN_PLACEHOLDER_MARKER}]`;

export const SEED_LABEL = "seed";

// `name` is the internal study name. Only the researchers see it (admin pages,
// exports). Participants see STUDY_SETTINGS.participantTitle instead.
export const STUDY = {
  slug: "dialect-translation-study",
  name: "Dialect-Aware Speech Translation Study",
};

// Settings keys that the settings type of the database package does not list yet.
export type SeedStudySettings = StudySettings & {
  // The title participants see (welcome heading, browser tab). Truthful and
  // without the research focus, so it does not prime participants (spec 6.1, 6.4).
  participantTitle?: string;
  participantTitleTranslations?: Record<string, string>;
  // Demo Mode: the largest number of demo pipeline runs per day.
  demoDailyRunLimit?: number;
};

export const STUDY_SETTINGS: SeedStudySettings = {
  participantTitle: "Speech and translation study",
  participantTitleTranslations: { fi: "Puhe- ja käännöstutkimus" },
  // A new deployment starts closed: the seeded study texts are examples. The
  // researchers replace them, publish their protocol and then open the study
  // on the Settings page.
  allowNewSessions: false,
  maintenanceMode: false,
  maintenanceMessage: null,
  autoQueueAsr: true,
  maxUploadMb: 100,
  maxUtteranceSeconds: 300,
  sessionInactivityTimeoutMinutes: 120,
  studyLaptopMode: false,
  demoPersist: true,
  demoPublic: false,
  demoDailyRunLimit: 200,
  sourceLanguage: "fi",
  targetLanguage: "en",
  participantLocales: ["fi", "en"],
  defaultLocale: "fi",
  transcriptionConventionVersion: "1.0",
  annotationSchemeVersion: "1.0",
  adminTimezone: "Europe/Helsinki",
  // The output review at the end of a session (docs/RESEARCH-DESIGN.md, section 3).
  // The number of reviewed recordings is a starting value for the pilot.
  outputReviewEnabled: true,
  outputReviewMaxItems: OUTPUT_REVIEW_DEFAULT_MAX_ITEMS,
  // Off: the background questionnaire asks for a self-rating of English reading.
  englishCheckEnabled: ENGLISH_CHECK_DEFAULT_ENABLED,
};

export const CONSENT = {
  title: "Information about the study and consent",
  informationText: [
    EXAMPLE_TEXT_NOTICE,
    "This study looks at how AI speech-translation technologies process different ways of speaking Finnish. If you take part, you will record several short spoken responses in Finnish and then answer a short questionnaire. The session takes about 20 minutes.",
    "Taking part is voluntary. You can stop at any time by closing the page or by choosing to stop participating.",
    "Your recordings and answers are stored under a random participant code, not under your name. The recordings are processed with external AI services (speech recognition, translation and speech synthesis) as part of the research.",
    "At the end you will see the text that the speech recognition wrote and two English translations of some of your recordings, and you will rate them. The AI may misrecognize what you said or render it differently from how you said it. You can skip this part.",
    `[${EXAMPLE_TEXT_PREFIX}: the data controller, the purpose and legal basis of the processing, the retention period, who has access to the data, and the rights of the participant.]`,
  ].join("\n\n"),
  privacyNoticeUrl: null,
  contactText: `[${EXAMPLE_TEXT_PREFIX}: name of the responsible researcher, research group, institution and contact email address.]`,
  items: [
    {
      id: "participation",
      text: "I have read the information above and I agree to take part in this study.",
      required: true,
      scope: "participation",
    },
    {
      id: "voice_recording",
      text: "I agree that my voice is recorded during the study.",
      required: true,
      scope: "voice_recording",
    },
    {
      id: "external_ai_processing",
      text: "I agree that my recordings are processed with external AI services for speech recognition, translation and speech synthesis.",
      required: true,
      scope: "external_ai_processing",
    },
    {
      id: "future_research_reuse",
      text: "Optional: I agree that my recordings and answers may be reused in later research under controlled access.",
      required: false,
      scope: "future_research_reuse",
    },
    {
      id: "output_review",
      // Required, so that every participant is told about the review; the right to
      // leave it out is the "Skip this part" button of the review itself
      // (reports/Source speaker output evaluation.md, "Recommended session protocol").
      text: "I understand that at the end of the study I will be shown the speech recognition text and the English translations of some of my recordings and asked to rate them, that the AI may misrecognize my speech, and that I can skip this part.",
      required: true,
      scope: "output_review",
    },
  ] satisfies ConsentItem[],
  translations: {
    fi: {
      title: "Tietoa tutkimuksesta ja suostumus",
      informationText: [
        EXAMPLE_TEXT_NOTICE_FI,
        "Tässä tutkimuksessa tarkastellaan, miten tekoälyyn perustuvat puheenkäännösteknologiat käsittelevät eri tavoin puhuttua suomea. Jos osallistut, äänität useita lyhyitä suomenkielisiä puhevastauksia ja vastaat sen jälkeen lyhyeen kyselyyn. Osallistuminen kestää noin 20 minuuttia.",
        "Osallistuminen on vapaaehtoista. Voit lopettaa milloin tahansa sulkemalla sivun tai valitsemalla osallistumisen lopettamisen.",
        "Äänitteesi ja vastauksesi tallennetaan satunnaisen osallistujatunnuksen alle, ei nimelläsi. Äänitteet käsitellään osana tutkimusta ulkoisilla tekoälypalveluilla (puheentunnistus, konekäännös ja puhesynteesi).",
        "Lopuksi näet puheentunnistuksen kirjoittaman tekstin ja kaksi englanninkielistä käännöstä joistakin äänitteistäsi ja arvioit niitä. Tekoäly voi tunnistaa sanomasi väärin tai esittää sen eri tavalla kuin sanoit sen. Voit ohittaa tämän osan.",
        `[${EXAMPLE_TEXT_PREFIX_FI}: rekisterinpitäjä, käsittelyn tarkoitus ja oikeusperuste, säilytysaika, kenellä on pääsy aineistoon sekä osallistujan oikeudet.]`,
      ].join("\n\n"),
      contactText: `[${EXAMPLE_TEXT_PREFIX_FI}: vastuullisen tutkijan nimi, tutkimusryhmä, organisaatio ja sähköpostiosoite.]`,
      items: {
        participation: "Olen lukenut yllä olevat tiedot ja suostun osallistumaan tähän tutkimukseen.",
        voice_recording: "Suostun siihen, että ääneni tallennetaan tutkimuksen aikana.",
        external_ai_processing:
          "Suostun siihen, että äänitteeni käsitellään ulkoisilla tekoälypalveluilla puheentunnistusta, konekäännöstä ja puhesynteesiä varten.",
        future_research_reuse:
          "Valinnainen: Suostun siihen, että äänitteitäni ja vastauksiani voidaan käyttää myöhemmässä tutkimuksessa valvotun käyttöoikeuden alaisena.",
        output_review:
          "Ymmärrän, että tutkimuksen lopussa minulle näytetään joidenkin äänitteideni puheentunnistusteksti ja englanninkieliset käännökset arvioitavaksi, että tekoäly voi tunnistaa puheeni väärin ja että voin ohittaa tämän osan.",
      },
    },
  } satisfies ConsentTranslations,
};

type SeedQuestionnaireItem = Omit<typeof questionnaireItems.$inferInsert, "questionnaireVersionId" | "orderIndex">;

const likert = (minLabel: string, maxLabel: string) => ({
  scaleMin: 1,
  scaleMax: 5,
  scaleMinLabel: minLabel,
  scaleMaxLabel: maxLabel,
});

// The Finnish texts of one questionnaire item.
const fi = (texts: NonNullable<QuestionnaireItemTranslations["fi"]>): QuestionnaireItemTranslations => ({ fi: texts });
const likertFi = (prompt: string, scaleMinLabel: string, scaleMaxLabel: string) =>
  fi({ prompt, scaleMinLabel, scaleMaxLabel });

// Spec 11. Collected after the speech tasks to reduce priming. The name and the
// description are shown to participants.
export const BACKGROUND_QUESTIONNAIRE = {
  key: "background",
  name: "Background questionnaire",
  description: "A few questions about you.",
  translations: { fi: { name: "Taustakysely", description: "Muutama kysymys sinusta." } },
  items: [
    {
      itemKey: "age_range",
      type: "single_choice",
      prompt: "What is your age range?",
      required: true,
      configJson: {
        options: [
          { value: "18_24", label: "18 to 24" },
          { value: "25_34", label: "25 to 34" },
          { value: "35_44", label: "35 to 44" },
          { value: "45_54", label: "45 to 54" },
          { value: "55_64", label: "55 to 64" },
          { value: "65_74", label: "65 to 74" },
          { value: "75_plus", label: "75 or older" },
          { value: "prefer_not_to_say", label: "I prefer not to say" },
        ],
      },
      translationsJson: fi({
        prompt: "Mihin ikäryhmään kuulut?",
        options: {
          "18_24": "18-24",
          "25_34": "25-34",
          "35_44": "35-44",
          "45_54": "45-54",
          "55_64": "55-64",
          "65_74": "65-74",
          "75_plus": "75 tai vanhempi",
          prefer_not_to_say: "En halua kertoa",
        },
      }),
    },
    {
      itemKey: "region_grew_up",
      type: "short_text",
      prompt: "In which municipality or region did you mainly grow up?",
      required: true,
      configJson: { maxLength: 200 },
      translationsJson: fi({ prompt: "Missä kunnassa tai millä alueella kasvoit pääasiassa?" }),
    },
    {
      itemKey: "other_places_lived",
      type: "short_text",
      prompt: "In which other places have you lived for a longer period?",
      helpText: "You can leave this empty.",
      required: false,
      configJson: { maxLength: 300 },
      translationsJson: fi({
        prompt: "Missä muualla olet asunut pidempään?",
        helpText: "Voit jättää tämän tyhjäksi.",
      }),
    },
    {
      itemKey: "current_region",
      type: "short_text",
      prompt: "In which region do you live now?",
      required: true,
      configJson: { maxLength: 200 },
      translationsJson: fi({ prompt: "Millä alueella asut nyt?" }),
    },
    {
      itemKey: "first_languages",
      type: "short_text",
      prompt: "What is your first language, or what are your first languages?",
      required: true,
      configJson: { maxLength: 200 },
      translationsJson: fi({ prompt: "Mikä on äidinkielesi, tai mitkä ovat äidinkielesi?" }),
    },
    {
      // A self-rating of English reading, used to interpret the participant's
      // ratings of the English versions in the review (it replaces the LexTALE
      // test, docs/IMPLEMENTATION-STATUS.md, "Deviations"). Every point is
      // labelled, so it is a single choice with the ordered values "1" to "5".
      itemKey: "english_reading",
      type: "single_choice",
      prompt: "How well do you understand written English?",
      required: true,
      configJson: {
        options: [
          { value: "1", label: "Not at all" },
          { value: "2", label: "A little" },
          { value: "3", label: "Moderately" },
          { value: "4", label: "Well" },
          { value: "5", label: "Very well" },
        ],
      },
      translationsJson: fi({
        prompt: "Kuinka hyvin ymmärrät kirjoitettua englantia?",
        options: { "1": "En lainkaan", "2": "Vähän", "3": "Kohtalaisesti", "4": "Hyvin", "5": "Erittäin hyvin" },
      }),
    },
    {
      itemKey: "languages_used_regularly",
      type: "short_text",
      prompt: "Which languages do you use regularly?",
      required: false,
      configJson: { maxLength: 300 },
      translationsJson: fi({ prompt: "Mitä kieliä käytät säännöllisesti?" }),
    },
    {
      itemKey: "own_finnish_description",
      type: "short_text",
      prompt: "How would you describe the Finnish you speak?",
      required: false,
      configJson: { maxLength: 300 },
      translationsJson: fi({ prompt: "Miten kuvailisit puhumaasi suomea?" }),
    },
    {
      itemKey: "identifies_with_regional_variety",
      type: "single_choice",
      prompt: "Do you feel that you speak a regional variety or dialect of Finnish?",
      required: false,
      configJson: {
        options: [
          { value: "yes", label: "Yes" },
          { value: "somewhat", label: "To some extent" },
          { value: "no", label: "No" },
          { value: "not_sure", label: "I am not sure" },
        ],
      },
      translationsJson: fi({
        prompt: "Koetko puhuvasi jotakin suomen alueellista puhetapaa tai murretta?",
        options: { yes: "Kyllä", somewhat: "Jossain määrin", no: "En", not_sure: "En ole varma" },
      }),
    },
    {
      itemKey: "self_description",
      type: "free_text",
      prompt: "Is there anything else you would like to tell us about how you speak?",
      helpText: "Optional.",
      required: false,
      configJson: { maxLength: 2000 },
      translationsJson: fi({
        prompt: "Haluatko kertoa meille vielä jotakin siitä, miten puhut?",
        helpText: "Valinnainen.",
      }),
    },
  ] satisfies SeedQuestionnaireItem[],
};

// Spec 12. Evaluates the recording experience, not translation quality. The name
// and the description are shown to participants.
export const POST_RECORDING_QUESTIONNAIRE = {
  key: "post_recording",
  name: "Post-recording questionnaire",
  description: "A few questions about how the recording went.",
  translations: {
    fi: { name: "Äänityksen jälkeinen kysely", description: "Muutama kysymys siitä, miten äänittäminen sujui." },
  },
  items: [
    {
      itemKey: "naturalness",
      type: "likert",
      prompt: "How naturally did you feel you were speaking?",
      required: true,
      configJson: likert("Not at all naturally", "Completely naturally"),
      translationsJson: likertFi("Kuinka luontevasti koit puhuvasi?", "Ei lainkaan luontevasti", "Täysin luontevasti"),
    },
    {
      itemKey: "changed_speech",
      type: "likert",
      prompt: "Did you deliberately change how you normally speak?",
      required: true,
      configJson: likert("Not at all", "Very much"),
      translationsJson: likertFi("Muutitko tietoisesti tavallista puhetapaasi?", "Ei lainkaan", "Hyvin paljon"),
    },
    {
      itemKey: "more_standard",
      type: "likert",
      prompt: "Did you try to speak more standard Finnish than usual?",
      required: true,
      configJson: likert("Not at all", "Very much"),
      translationsJson: likertFi("Yrititkö puhua tavallista yleiskielisempää suomea?", "Ei lainkaan", "Hyvin paljon"),
    },
    {
      itemKey: "emphasized_regional",
      type: "likert",
      prompt: "Did you consciously emphasize regional or dialectal features?",
      required: true,
      configJson: likert("Not at all", "Very much"),
      translationsJson: likertFi(
        "Korostitko tietoisesti alueellisia tai murteellisia piirteitä?",
        "Ei lainkaan",
        "Hyvin paljon",
      ),
    },
    {
      itemKey: "comfort",
      type: "likert",
      prompt: "How comfortable were you speaking to the computer?",
      required: true,
      configJson: likert("Not at all comfortable", "Very comfortable"),
      translationsJson: likertFi("Kuinka mukavalta tuntui puhua tietokoneelle?", "Ei lainkaan mukavalta", "Erittäin mukavalta"),
    },
    {
      itemKey: "task_felt_unnatural",
      type: "likert",
      prompt: "Did any task feel unnatural?",
      required: true,
      configJson: likert("Not at all", "Very much"),
      translationsJson: likertFi("Tuntuiko jokin tehtävä epäluontevalta?", "Ei lainkaan", "Hyvin paljon"),
    },
    {
      itemKey: "free_comment",
      type: "free_text",
      prompt: "Is there anything else you would like to tell us?",
      helpText: "Optional.",
      required: false,
      configJson: { maxLength: 2000 },
      translationsJson: fi({ prompt: "Haluatko kertoa meille vielä jotakin?", helpText: "Valinnainen." }),
    },
  ] satisfies SeedQuestionnaireItem[],
};

// The questionnaire after the output review (docs/RESEARCH-DESIGN.md, section 3).
// Its last item asks what the participant thinks the study was about, so that
// awareness of the hypothesis can be coded afterwards.
export const POST_REVIEW_QUESTIONNAIRE = {
  key: "post_review",
  name: "Questions about the translations",
  description: "A few questions about what you just saw.",
  translations: {
    fi: { name: "Kysymyksiä käännöksistä", description: "Muutama kysymys siitä, mitä juuri näit." },
  },
  items: [
    {
      itemKey: "overall_representation",
      type: "likert",
      prompt: "Overall, how well did the English versions represent the way you speak?",
      required: true,
      configJson: likert("Not at all well", "Very well"),
      translationsJson: likertFi(
        "Kuinka hyvin englanninkieliset versiot kaiken kaikkiaan välittivät sen, miten puhut?",
        "Ei lainkaan hyvin",
        "Erittäin hyvin",
      ),
    },
    {
      itemKey: "trust_after_review",
      type: "likert",
      prompt: "After seeing these translations, how much do you trust AI translation of spoken Finnish?",
      required: true,
      configJson: likert("Not at all", "Completely"),
      translationsJson: likertFi(
        "Kuinka paljon luotat näiden käännösten näkemisen jälkeen puhutun suomen tekoälykäännökseen?",
        "En lainkaan",
        "Täysin",
      ),
    },
    {
      itemKey: "would_use",
      type: "likert",
      prompt: "Would you use this kind of translation to talk with an English speaker?",
      required: true,
      configJson: likert("Definitely not", "Definitely yes"),
      translationsJson: likertFi(
        "Käyttäisitkö tällaista käännöstä keskustellessasi englanninkielisen kanssa?",
        "En varmasti",
        "Varmasti",
      ),
    },
    {
      itemKey: "review_comments",
      type: "free_text",
      prompt: "Any comments on the texts or translations you saw?",
      helpText: "Optional.",
      required: false,
      configJson: { maxLength: 2000 },
      translationsJson: fi({ prompt: "Haluatko kommentoida näkemiäsi tekstejä tai käännöksiä?", helpText: "Valinnainen." }),
    },
    {
      itemKey: "study_about",
      type: "free_text",
      prompt: "What do you think this study was about?",
      helpText: "Optional.",
      required: false,
      configJson: { maxLength: 2000 },
      translationsJson: fi({ prompt: "Mistä arvelet tässä tutkimuksessa olleen kyse?", helpText: "Valinnainen." }),
    },
  ] satisfies SeedQuestionnaireItem[],
};

// Spec 6.1: truthful, no directional hypothesis, no dialect priming.
export const PROTOCOL = {
  name: "Initial study flow",
  // Shown in the admin only.
  description: `${ADMIN_PLACEHOLDER} Example protocol from the development seed (spec 92). Not approved for data collection.`,
  welcomeContent: [
    EXAMPLE_TEXT_NOTICE,
    "Welcome to this research study.",
    "We are studying how AI speech-translation technologies process different ways of speaking Finnish. The study is carried out by [research group, institution].",
    "The study takes approximately 20 minutes.",
    "You will be asked to record several short spoken responses in Finnish. Your voice will be recorded.",
  ].join("\n\n"),
  informationContent: [
    EXAMPLE_TEXT_NOTICE,
    "On the following pages you will first read the study information and give your consent. You will then check your microphone, record your responses to a few speaking tasks and answer a short questionnaire.",
    "You can stop at any time. For questions, contact [contact details of the responsible researcher].",
  ].join("\n\n"),
  // Spec 6.4.
  instructionContent: [
    EXAMPLE_TEXT_NOTICE,
    "You will see a few short speaking tasks, one at a time. Each task describes a situation or a topic. Read it, then record your response in Finnish.",
    "Speak naturally, in the way you would normally speak in the situation described. There is no correct way to speak and you do not need to use standard written Finnish.",
    "Press the record button to start and press it again to stop. You can listen to your own recording, and you can record it again before you submit it. Only the recording you submit is kept.",
    "You can stop participating at any time.",
  ].join("\n\n"),
  // Spec 13. No promise of a right or deletion workflow that has not been defined.
  debriefContent: [
    EXAMPLE_TEXT_NOTICE,
    "Thank you for taking part.",
    "In this study we compare how speech recognition, machine translation and speech synthesis handle Finnish as it is actually spoken, including regional and informal ways of speaking. Your recordings help us examine how these systems treat such features when speech is translated automatically.",
    "If you rated translations at the end: speech recognition and translation systems often have trouble with everyday and regional ways of speaking. If a text did not match what you said, that is a limitation of the systems, not of how you speak.",
    "Your participant code is shown on this page. Please keep it: you need it if you contact the researchers about your participation.",
    `[${EXAMPLE_TEXT_PREFIX}: contact details, and the information about withdrawal and discontinuation according to the approved protocol.]`,
  ].join("\n\n"),
  translations: {
    fi: {
      welcomeContent: [
        EXAMPLE_TEXT_NOTICE_FI,
        "Tervetuloa tähän tutkimukseen.",
        "Tutkimme, miten tekoälyyn perustuvat puheenkäännösteknologiat käsittelevät eri tavoin puhuttua suomea. Tutkimuksen toteuttaa [tutkimusryhmä, organisaatio].",
        "Tutkimus kestää noin 20 minuuttia.",
        "Sinua pyydetään äänittämään useita lyhyitä suomenkielisiä puhevastauksia. Äänesi tallennetaan.",
      ].join("\n\n"),
      informationContent: [
        EXAMPLE_TEXT_NOTICE_FI,
        "Seuraavilla sivuilla luet ensin tutkimustiedotteen ja annat suostumuksesi. Sen jälkeen tarkistat mikrofonisi, äänität vastauksesi muutamaan puhetehtävään ja vastaat lyhyeen kyselyyn.",
        "Voit lopettaa milloin tahansa. Jos sinulla on kysyttävää, ota yhteyttä: [vastuullisen tutkijan yhteystiedot].",
      ].join("\n\n"),
      instructionContent: [
        EXAMPLE_TEXT_NOTICE_FI,
        "Näet muutaman lyhyen puhetehtävän yksi kerrallaan. Jokainen tehtävä kuvaa tilanteen tai aiheen. Lue se ja äänitä sitten vastauksesi suomeksi.",
        "Puhu luontevasti, niin kuin tavallisesti puhuisit kuvatussa tilanteessa. Ei ole yhtä oikeaa tapaa puhua, eikä sinun tarvitse käyttää kirjakieltä.",
        "Aloita äänitys painamalla äänityspainiketta ja lopeta painamalla sitä uudelleen. Voit kuunnella äänitteesi ja äänittää sen uudelleen ennen lähettämistä. Vain lähettämäsi äänite säilytetään.",
        "Voit lopettaa osallistumisen milloin tahansa.",
      ].join("\n\n"),
      debriefContent: [
        EXAMPLE_TEXT_NOTICE_FI,
        "Kiitos osallistumisestasi.",
        "Tässä tutkimuksessa vertaamme, miten puheentunnistus, konekäännös ja puhesynteesi käsittelevät suomea sellaisena kuin sitä todella puhutaan, myös alueellisia ja arkisia puhetapoja. Äänitteesi auttavat meitä selvittämään, miten nämä järjestelmät kohtelevat tällaisia piirteitä, kun puhe käännetään automaattisesti.",
        "Jos arvioit lopuksi käännöksiä: puheentunnistus- ja käännösjärjestelmillä on usein vaikeuksia arkisen ja alueellisen puheen kanssa. Jos teksti ei vastannut sitä, mitä sanoit, se johtuu järjestelmien rajoituksista, ei puhetavastasi.",
        "Osallistujatunnuksesi näkyy tällä sivulla. Säilytä se: tarvitset sitä, jos otat yhteyttä tutkijoihin osallistumisestasi.",
        `[${EXAMPLE_TEXT_PREFIX_FI}: yhteystiedot sekä tiedot osallistumisen peruuttamisesta ja keskeyttämisestä hyväksytyn tutkimussuunnitelman mukaisesti.]`,
      ].join("\n\n"),
    },
  } satisfies ProtocolTranslations,
  orderConfig: {
    blocks: [
      { key: "controlled", title: "Controlled tasks", orderMode: "shuffle_within_block" },
      { key: "semi_structured", title: "Semi-structured tasks", orderMode: "fixed" },
      { key: "free", title: "Free speech", orderMode: "fixed" },
    ],
  } satisfies ProtocolOrderConfig,
};

type SeedTask = Omit<typeof protocolTasks.$inferInsert, "protocolVersionId" | "orderIndex"> & {
  followups: Array<{
    followupKey: string;
    promptText: string;
    isRequired: boolean;
    translationsJson?: FollowupTranslations;
  }>;
};

// Spec 92. Prompt texts are the placeholder texts of the specification.
export const PROTOCOL_TASKS: SeedTask[] = [
  {
    taskKey: "controlled_invitation",
    internalName: "Controlled 1: unsure about an invitation",
    taskType: "controlled",
    title: "An invitation",
    participantPrompt:
      "Imagine an English-speaking friend has invited you somewhere this weekend. Respond naturally in Finnish and explain that you are unsure whether you want to go.",
    blockKey: "controlled",
    orderMode: "shuffle_within_block",
    suggestedDurationSeconds: 30,
    maxDurationSeconds: 120,
    configJson: { randomizationEligible: true },
    translationsJson: {
      fi: {
        title: "Kutsu",
        participantPrompt:
          "Kuvittele, että englanninkielinen ystäväsi on kutsunut sinut jonnekin tänä viikonloppuna. Vastaa luontevasti suomeksi ja selitä, ettet ole varma, haluatko lähteä.",
      },
    },
    followups: [],
  },
  {
    taskKey: "controlled_unexpected",
    internalName: "Controlled 2: something went differently than expected",
    taskType: "controlled",
    title: "Something unexpected",
    participantPrompt:
      "Imagine you need to tell an English-speaking person that something did not happen the way you expected. Explain what happened naturally in Finnish.",
    blockKey: "controlled",
    orderMode: "shuffle_within_block",
    suggestedDurationSeconds: 30,
    maxDurationSeconds: 120,
    configJson: { randomizationEligible: true },
    translationsJson: {
      fi: {
        title: "Jotain odottamatonta",
        participantPrompt:
          "Kuvittele, että sinun pitää kertoa englanninkieliselle henkilölle, ettei jokin mennyt niin kuin odotit. Kerro luontevasti suomeksi, mitä tapahtui.",
      },
    },
    followups: [],
  },
  {
    taskKey: "semi_where_grew_up",
    internalName: "Semi-structured 1: the place where you grew up",
    taskType: "semi_structured",
    title: "Where you grew up",
    participantPrompt: "Tell us about the place where you grew up and what makes it distinctive.",
    blockKey: "semi_structured",
    orderMode: "fixed",
    suggestedDurationSeconds: 60,
    maxDurationSeconds: 180,
    configJson: { followupMode: "always" },
    translationsJson: {
      fi: {
        title: "Missä kasvoit",
        participantPrompt: "Kerro paikasta, jossa kasvoit, ja siitä, mikä tekee siitä omanlaisensa.",
      },
    },
    // The specification's example for this task (spec 92) asks "Is there
    // anything distinctive about how people speak there?". That question draws
    // attention to speech variety before two further speech tasks, which spec
    // 6.4 forbids. The seed uses the neutral follow-up example of spec 7.2
    // instead (docs/IMPLEMENTATION-STATUS.md, Deviations).
    followups: [
      {
        followupKey: "typical_situation",
        promptText: "Tell us about a typical situation you remember from there.",
        isRequired: true,
        translationsJson: { fi: { promptText: "Kerro jostakin tyypillisestä tilanteesta, jonka muistat sieltä." } },
      },
    ],
  },
  {
    taskKey: "semi_polite_disagreement",
    internalName: "Semi-structured 2: disagreeing politely",
    taskType: "semi_structured",
    title: "A polite disagreement",
    participantPrompt: "Tell us about a situation where you had to disagree with someone politely.",
    blockKey: "semi_structured",
    orderMode: "fixed",
    suggestedDurationSeconds: 60,
    maxDurationSeconds: 180,
    configJson: {},
    translationsJson: {
      fi: {
        title: "Kohtelias erimielisyys",
        participantPrompt: "Kerro tilanteesta, jossa sinun piti olla jonkun kanssa kohteliaasti eri mieltä.",
      },
    },
    followups: [],
  },
  {
    taskKey: "free_speech",
    internalName: "Free speech",
    taskType: "free_speech",
    title: "Free speech",
    participantPrompt:
      "Speak naturally in Finnish about anything you would like to communicate to an English-speaking person. Aim for about one to two minutes. Please avoid using real people's full names or unnecessary identifying information.",
    blockKey: "free",
    orderMode: "fixed",
    suggestedDurationSeconds: 90,
    maxDurationSeconds: 300,
    privacyReminder: true,
    configJson: {},
    translationsJson: {
      fi: {
        title: "Vapaa puhe",
        participantPrompt:
          "Puhu luontevasti suomeksi mistä tahansa, mitä haluaisit kertoa englanninkieliselle henkilölle. Tavoitteena on noin yhdestä kahteen minuuttia. Vältä oikeiden ihmisten koko nimiä ja tarpeettomia tunnistetietoja.",
      },
    },
    followups: [],
  },
];

// Spec 93 and 94: the prompt texts are copied exactly from the specification.
export const AI_PROMPTS = [
  {
    key: "asr_context",
    stage: "asr",
    conditionKey: null,
    name: "ASR context",
    promptText: "The recording contains spontaneous spoken Finnish.",
    notes:
      "Short neutral context for the speech recognition model. It names the language and nothing else, so it does not push the output toward standard or dialectal forms.",
  },
  {
    key: "translation_default",
    stage: "translation",
    conditionKey: "default",
    name: "Default translation",
    promptText: [
      "Translate the following Finnish utterance into natural spoken English.",
      "Preserve its meaning.",
      "Return only the translation.",
    ].join("\n"),
    notes: "Initial default translation prompt (spec 93).",
  },
  {
    key: "translation_preserve",
    stage: "translation",
    conditionKey: "preservation",
    name: "Preservation-aware translation",
    promptText: [
      "Translate the following Finnish utterance into natural spoken English.",
      "",
      "Preserve propositional meaning and communicatively relevant differences",
      "in register, informality, stance, politeness, discourse organization,",
      "idiomatic force, humour, and emphasis where supported by the source.",
      "",
      "Use natural English equivalents rather than copying Finnish forms.",
      "",
      "Do not arbitrarily assign the speaker a named English regional dialect.",
      "Do not add stereotypical dialect markers.",
      "Do not invent information, emotion, emphasis, or social meaning that",
      "is not supported by the source.",
      "",
      "Return only the translation.",
    ].join("\n"),
    notes: "Initial preservation-aware translation prompt (spec 93).",
  },
  {
    key: "tts_baseline",
    stage: "tts",
    conditionKey: "baseline",
    name: "TTS baseline",
    promptText: [
      "Speak the text naturally in conversational English.",
      "Do not deliberately adopt a named regional dialect.",
      "Do not add, omit, or paraphrase words.",
    ].join("\n"),
    notes: "Initial speech synthesis instruction (spec 94). One fixed voice for all main conditions.",
  },
] as const;

// `store: false` asks the provider not to keep the translation response for
// later retrieval. It is a parameter the translation adapter accepts
// (packages/ai/src/providers/openai/translator.ts). Not storing is the
// conservative default for participant speech content. What the provider
// retains otherwise depends on the account and the agreement with the provider
// (docs/PRIVACY-IMPLEMENTATION-NOTES.md).
const TRANSLATION_PARAMETERS = { store: false } as const;

export const MODEL_CONFIGS = [
  {
    key: "asr_default",
    stage: "asr",
    conditionKey: null,
    name: "ASR default",
    provider: "openai",
    modelId: "gpt-transcribe",
    parameters: { language: "fi" },
    promptKey: "asr_context",
  },
  {
    key: "translation_default",
    stage: "translation",
    conditionKey: "default",
    name: "Translation, default condition",
    provider: "openai",
    modelId: "gpt-5.6-sol",
    parameters: TRANSLATION_PARAMETERS,
    promptKey: "translation_default",
  },
  {
    key: "translation_preserve",
    stage: "translation",
    conditionKey: "preservation",
    name: "Translation, preservation condition",
    provider: "openai",
    modelId: "gpt-5.6-sol",
    parameters: TRANSLATION_PARAMETERS,
    promptKey: "translation_preserve",
  },
  {
    key: "tts_baseline",
    stage: "tts",
    conditionKey: "baseline",
    name: "TTS baseline voice",
    provider: "openai",
    modelId: "gpt-4o-mini-tts",
    parameters: { voice: "alloy", response_format: "wav" },
    promptKey: "tts_baseline",
  },
] as const;
