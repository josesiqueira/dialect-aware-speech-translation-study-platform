// The works cited on the Scientific Relevance page. Every entry was checked on
// a real page (publisher, ACL Anthology, ISCA Archive, DOI resolver, arXiv or
// the author's repository) on 2026-10-09. A source that could not be checked is
// not listed. `note` says what was not read first-hand.

export interface Reference {
  /** The author-year label used in the text, for example "Toury 1995". */
  key: string;
  citation: string;
  url: string;
  note?: string;
}

export const REFERENCES: Reference[] = [
  {
    key: "Agha 2003",
    citation: "Agha, A. (2003). The social life of cultural value. Language & Communication, 23(3-4), 231-273.",
    url: "https://doi.org/10.1016/S0271-5309(03)00012-0",
  },
  {
    key: "Bender & Friedman 2018",
    citation:
      "Bender, E. M., & Friedman, B. (2018). Data Statements for Natural Language Processing: Toward Mitigating System Bias and Enabling Better Science. Transactions of the ACL, 6, 587-604.",
    url: "https://doi.org/10.1162/tacl_a_00041",
  },
  {
    key: "Berezowski 1997",
    citation: "Berezowski, L. (1997). Dialect in Translation. Wrocław: Wydawnictwo Uniwersytetu Wrocławskiego.",
    url: "https://hds.hebis.de/herder/Record/HEB056949219",
    note: "The list of ten strategies was checked in secondary sources, not in the book.",
  },
  {
    key: "Bird 2020",
    citation: "Bird, S. (2020). Decolonising Speech and Language Technology. Proceedings of COLING 2020, 3504-3519.",
    url: "https://doi.org/10.18653/v1/2020.coling-main.313",
  },
  {
    key: "Blodgett et al. 2020",
    citation:
      "Blodgett, S. L., Barocas, S., Daumé III, H., & Wallach, H. (2020). Language (Technology) is Power: A Critical Survey of \"Bias\" in NLP. Proceedings of ACL 2020, 5454-5476.",
    url: "https://doi.org/10.18653/v1/2020.acl-main.485",
  },
  {
    key: "Campbell-Kibler 2007",
    citation: "Campbell-Kibler, K. (2007). Accent, (ING), and the Social Logic of Listener Perceptions. American Speech, 82(1), 32-64.",
    url: "https://doi.org/10.1215/00031283-2007-002",
  },
  {
    key: "Cohn & Zellou 2020",
    citation:
      "Cohn, M., & Zellou, G. (2020). Perception of Concatenative vs. Neural Text-To-Speech (TTS): Differences in Intelligibility in Noise and Language Attitudes. Proceedings of Interspeech 2020, 1733-1737.",
    url: "https://doi.org/10.21437/Interspeech.2020-1336",
  },
  {
    key: "Eckert 2008",
    citation: "Eckert, P. (2008). Variation and the indexical field. Journal of Sociolinguistics, 12(4), 453-476.",
    url: "https://doi.org/10.1111/j.1467-9841.2008.00374.x",
  },
  {
    key: "EDPB 2021",
    citation: "European Data Protection Board (2021). Guidelines 02/2021 on Virtual Voice Assistants, version 2.0.",
    url: "https://www.edpb.europa.eu/system/files/2021-07/edpb_guidelines_202102_on_vva_v2.0_adopted_en.pdf",
  },
  {
    key: "Enarvi et al. 2017",
    citation:
      "Enarvi, S., Smit, P., Virpioja, S., & Kurimo, M. (2017). Automatic speech recognition with very large conversational Finnish and Estonian vocabularies. IEEE/ACM Transactions on Audio, Speech, and Language Processing, 25(11), 2085-2097.",
    url: "https://doi.org/10.1109/TASLP.2017.2743344",
  },
  {
    key: "Feng et al. 2024",
    citation:
      "Feng, S., Halpern, B. M., Kudina, O., & Scharenborg, O. (2024). Towards inclusive automatic speech recognition. Computer Speech & Language, 84, 101567.",
    url: "https://doi.org/10.1016/j.csl.2023.101567",
  },
  {
    key: "Fleisig et al. 2024",
    citation:
      "Fleisig, E., Smith, G., Bossi, M., Rustagi, I., Yin, X., & Klein, D. (2024). Linguistic Bias in ChatGPT: Language Models Reinforce Dialect Discrimination. Proceedings of EMNLP 2024, 13541-13564.",
    url: "https://doi.org/10.18653/v1/2024.emnlp-main.750",
  },
  {
    key: "Freitag et al. 2021",
    citation:
      "Freitag, M., Foster, G., Grangier, D., Ratnakar, V., Tan, Q., & Macherey, W. (2021). Experts, Errors, and Context: A Large-Scale Study of Human Evaluation for Machine Translation. Transactions of the ACL, 9, 1460-1474.",
    url: "https://doi.org/10.1162/tacl_a_00437",
  },
  {
    key: "Galesic & Bosnjak 2009",
    citation:
      "Galesic, M., & Bosnjak, M. (2009). Effects of Questionnaire Length on Participation and Indicators of Response Quality in a Web Survey. Public Opinion Quarterly, 73(2), 349-360.",
    url: "https://doi.org/10.1093/poq/nfp031",
  },
  {
    key: "Song et al. 2025",
    citation:
      "Song, Y., Riley, P., Deutsch, D., & Freitag, M. (2025). Enhancing Human Evaluation in Machine Translation with Comparative Judgement. Proceedings of ACL 2025, 20536-20551.",
    url: "https://aclanthology.org/2025.acl-long.1002/",
  },
  {
    key: "Hofmann et al. 2024",
    citation:
      "Hofmann, V., Kalluri, P. R., Jurafsky, D., & King, S. (2024). AI generates covertly racist decisions about people based on their dialect. Nature, 633, 147-154.",
    url: "https://doi.org/10.1038/s41586-024-07856-5",
  },
  {
    key: "Hutiri et al. 2024",
    citation:
      "Hutiri, W., Papakyriakopoulos, O., & Xiang, A. (2024). Not My Voice! A Taxonomy of Ethical and Safety Harms of Speech Generators. Proceedings of ACM FAccT 2024, 359-376.",
    url: "https://doi.org/10.1145/3630106.3658911",
  },
  {
    key: "Hämäläinen et al. 2021",
    citation:
      "Hämäläinen, M., Alnajjar, K., Partanen, N., & Rueter, J. (2021). Finnish Dialect Identification: The Effect of Audio and Text. Proceedings of EMNLP 2021, 8777-8783.",
    url: "https://aclanthology.org/2021.emnlp-main.692",
  },
  {
    key: "Kantharuban et al. 2023",
    citation:
      "Kantharuban, A., Vulić, I., & Korhonen, A. (2023). Quantifying the Dialect Gap and its Correlates Across Languages. Findings of EMNLP 2023, 7226-7245.",
    url: "https://doi.org/10.18653/v1/2023.findings-emnlp.481",
  },
  {
    key: "Koenecke et al. 2020",
    citation:
      "Koenecke, A., Nam, A., Lake, E., Nudell, J., Quartey, M., Mengesha, Z., Toups, C., Rickford, J. R., Jurafsky, D., & Goel, S. (2020). Racial disparities in automated speech recognition. PNAS, 117(14), 7684-7689.",
    url: "https://doi.org/10.1073/pnas.1915768117",
  },
  {
    key: "Kotus",
    citation: "Institute for the Languages of Finland (Kotus). Dialects.",
    url: "https://en.kotus.fi/on-language/dialects/",
  },
  {
    key: "Kuparinen 2025",
    citation:
      "Kuparinen, O. (2025). Automatic Dialectal Transcription: An Evaluation on Finnish and Norwegian. Proceedings of Interspeech 2025, 2390-2394.",
    url: "https://doi.org/10.21437/Interspeech.2025-2602",
  },
  {
    key: "Kuparinen & Scherrer 2023",
    citation:
      "Kuparinen, O., & Scherrer, Y. (2023). Dialect Representation Learning with Neural Dialect-to-Standard Normalization. Proceedings of VarDial 2023, 200-212.",
    url: "https://doi.org/10.18653/v1/2023.vardial-1.20",
  },
  {
    key: "Kuparinen 2024",
    citation: "Kuparinen, O. (2024). Murre24: Dialect Identification of Finnish Internet Forum Messages. Proceedings of LREC-COLING 2024, 12003-12015.",
    url: "https://aclanthology.org/2024.lrec-main.1048",
  },
  {
    key: "Kuparinen 2026",
    citation:
      "Kuparinen, O. (2026). Effects of Speaker Bias in Dialect Identification and Automatic Transcription with Self-Supervised Speech Models. Proceedings of VarDial 2026.",
    url: "https://doi.org/10.18653/v1/2026.vardial-1.3",
  },
  {
    key: "Kuparinen & Vaattovaara 2025",
    citation:
      "Kuparinen, O., & Vaattovaara, J. (2025). Murteesta ja identiteetistä 2020-luvulla [On dialect and identity in the 2020s: monitoring linguistic change through the self-report method]. Virittäjä.",
    url: "https://doi.org/10.23982/vir.148345",
  },
  {
    key: "Michel et al. 2025",
    citation:
      "Michel, S., Kaur, S., Gillespie, S. E., Gleason, J., Wilson, C., & Ghosh, A. (2025). \"It's not a representation of me\": Examining Accent Bias and Digital Exclusion in Synthetic AI Voice Services. Proceedings of ACM FAccT 2025.",
    url: "https://doi.org/10.1145/3715275.3732018",
  },
  {
    key: "Nisioi et al. 2022",
    citation: "Nisioi, S., Uban, A. S., & Dinu, L. P. (2022). Identifying Source-Language Dialects in Translation. Mathematics, 10(9), 1431.",
    url: "https://doi.org/10.3390/math10091431",
  },
  {
    key: "Popescu-Belis et al. 2025",
    citation:
      "Popescu-Belis, A., Allemann, A., Ferrari, T., & Krishnamani, G. (2025). Speech-to-Speech Translation Pipelines for Conversations in Low-Resource Languages. Proceedings of MT Summit XX, Vol. 2, 18-27.",
    url: "https://aclanthology.org/2025.mtsummit-2.3",
  },
  {
    key: "Ramos Pinto 2018",
    citation:
      "Ramos Pinto, S. (2018, online 2017). Film, dialects and subtitles: an analytical framework for the study of non-standard varieties in subtitling. The Translator, 24(1), 17-34.",
    url: "https://doi.org/10.1080/13556509.2017.1338551",
  },
  {
    key: "Robinson et al. 2026",
    citation:
      "Robinson, N. R., Abdelmoneim, S., Kantharuban, A., Alsboul, O., Lamsiyah, S., Marchisio, K., & Murray, K. (2026). AMIYA Shared Task: Arabic Modeling In Your Accent at VarDial 2026. Proceedings of the 13th Workshop on NLP for Similar Languages, Varieties and Dialects (VarDial 2026).",
    url: "https://doi.org/10.18653/v1/2026.vardial-1.1",
  },
  {
    key: "Shterionov et al. 2026",
    citation:
      "Shterionov, D., van Helleman, N., & Vanmassenhove, E. (2026). Diversity and Homogenisation in Generative AI Translation: A Comparative Study of English-Dutch Translation Across Domains. Proceedings of EAMT 2026, 61-75.",
    url: "https://aclanthology.org/2026.eamt-1.6",
  },
  {
    key: "Sourati et al. 2026",
    citation:
      "Sourati, Z., Karimi-Malekabadi, F., Ozcan, M., McDaniel, C., Ziabari, A., Trager, J., Tak, A. N., Chen, M., Morstatter, F., & Dehghani, M. (2026). The shrinking landscape of linguistic diversity in the age of large language models. Nature Human Behaviour.",
    url: "https://doi.org/10.1038/s41562-026-02550-0",
    note: "Figures checked through the journal's press release and the preprint (arXiv:2502.11266).",
  },
  {
    key: "Székely et al. 2024",
    citation: "Székely, É., Higginbotham, J., & Possemato, F. (2024). Voice and Choice: Investigating the Role of Prosodic Variation in Request Compliance and Perceived Politeness Using Conversational TTS. Proceedings of SIGDIAL 2024.",
    url: "https://doi.org/10.18653/v1/2024.sigdial-1.40",
  },
  {
    key: "Székely et al. 2025",
    citation:
      "Székely, É., Miniota, J., & Hejná, M. (2025). Will AI shape the way we speak? The emerging sociolinguistic influence of synthetic voices. Proceedings of IWSDS 2025. Position paper.",
    url: "https://aclanthology.org/2025.iwsds-1.37",
  },
  {
    key: "Birt et al. 2016",
    citation: "Birt, L., Scott, S., Cavers, D., Campbell, C., & Walter, F. (2016). Member Checking. Qualitative Health Research, 26(13), 1802-1811.",
    url: "https://doi.org/10.1177/1049732316654870",
    note: "Checked through the abstract.",
  },
  {
    key: "Lyle 2003",
    citation: "Lyle, J. (2003). Stimulated recall: a report on its use in naturalistic research. British Educational Research Journal, 29(6), 861-878.",
    url: "https://doi.org/10.1080/0141192032000137349",
    note: "Checked through the abstract.",
  },
  {
    key: "Martindale & Carpuat 2018",
    citation:
      "Martindale, M., & Carpuat, M. (2018). Fluency Over Adequacy: A Pilot Study in Measuring User Trust in Imperfect MT. Proceedings of AMTA 2018 (Volume 1: Research Track), 13-25.",
    url: "https://aclanthology.org/W18-1803/",
  },
  {
    key: "Mengesha et al. 2021",
    citation:
      "Mengesha, Z., Heldreth, C., Lahav, M., Sublewski, J., & Tuennerman, E. (2021). \"I don't Think These Devices are Very Culturally Sensitive.\": Impact of Automated Speech Recognition Errors on African Americans. Frontiers in Artificial Intelligence, 4.",
    url: "https://doi.org/10.3389/frai.2021.725911",
  },
  {
    key: "Zouhar et al. 2021",
    citation:
      "Zouhar, V., Novák, M., Žilinec, M., Bojar, O., Obregón, M., Hill, R. L., Blain, F., Fomicheva, M., et al. (2021). Backtranslation Feedback Improves User Confidence in MT, Not Quality. Proceedings of NAACL-HLT 2021, 151-161.",
    url: "https://aclanthology.org/2021.naacl-main.14/",
  },
  {
    key: "Leppihalme 2000",
    citation:
      "Leppihalme, R. (2000). The Two Faces of Standardization: On the Translation of Regionalisms in Literary Dialogue. The Translator, 6(2), 247-269.",
    url: "https://doi.org/10.1080/13556509.2000.10799068",
    note: "Content checked through Rosa (2012), not read first-hand.",
  },
  {
    key: "Lommel et al. 2014",
    citation:
      "Lommel, A., Uszkoreit, H., & Burchardt, A. (2014). Multidimensional Quality Metrics (MQM): A Framework for Declaring and Describing Translation Quality Metrics. Tradumàtica, 12, 455-463.",
    url: "https://doi.org/10.5565/rev/tradumatica.77",
  },
  {
    key: "Luukkonen et al. 2025",
    citation: "Luukkonen, R., et al. (2025). Poro 34B and the Blessing of Multilinguality. Proceedings of NoDaLiDa/Baltic-HLT 2025, 367-382.",
    url: "https://aclanthology.org/2025.nodalida-1.40",
  },
  {
    key: "Markl 2022",
    citation:
      "Markl, N. (2022). Language variation and algorithmic bias: understanding algorithmic bias in British English automatic speech recognition. Proceedings of ACM FAccT 2022, 521-534.",
    url: "https://doi.org/10.1145/3531146.3533117",
  },
  {
    key: "Moisio et al. 2023",
    citation:
      "Moisio, A., Porjazovski, D., Rouhe, A., Getman, Y., Virkkunen, A., AlGhezi, R., Lennes, M., Grósz, T., Lindén, K., & Kurimo, M. (2023). Lahjoita puhetta: a large-scale corpus of spoken Finnish with some benchmarks. Language Resources and Evaluation, 57(3), 1295-1327.",
    url: "https://doi.org/10.1007/s10579-022-09606-3",
  },
  {
    key: "Määttä 2004",
    citation: "Määttä, S. K. (2004). Dialect and point of view: The ideology of translation in The Sound and the Fury in French. Target, 16(2), 319-339.",
    url: "https://doi.org/10.1075/target.16.2.06maa",
  },
  {
    key: "Nautsch et al. 2019",
    citation:
      "Nautsch, A., Jiménez, A., Treiber, A., Kolberg, J., Jasserand, C., Kindt, E., et al. (2019). Preserving privacy in speaker and speech characterisation. Computer Speech & Language, 58, 441-480.",
    url: "https://doi.org/10.1016/j.csl.2019.06.001",
  },
  {
    key: "Nădejde et al. 2022",
    citation:
      "Nădejde, M., Currey, A., Hsu, B., Niu, X., Federico, M., & Dinu, G. (2022). CoCoA-MT: A Dataset and Benchmark for Contrastive Controlled MT with Application to Formality. Findings of NAACL 2022, 616-632.",
    url: "https://doi.org/10.18653/v1/2022.findings-naacl.47",
  },
  {
    key: "Nuolijärvi & Vaattovaara 2011",
    citation:
      "Nuolijärvi, P., & Vaattovaara, J. (2011). De-standardisation in progress in Finnish society? In T. Kristiansen & N. Coupland (Eds.), Standard Languages and Language Standards in a Changing Europe (pp. 67-74). Oslo: Novus.",
    url: "https://lanchart.hum.ku.dk/research/slice/publications-and-news-letters/publications/standard_languages/Nuolij_rvi_and_Vaattovaara_-_De-standardisation_in_progress_in_Finnish_society_-_p_67-74.pdf",
  },
  {
    key: "Palander 2007",
    citation: "Palander, M. (2007). Alueellisen taustan vaikutus murrekäsityksiin. Virittäjä, 111(1), 24-55.",
    url: "https://journal.fi/virittaja/article/view/40541",
  },
  {
    key: "Partanen et al. 2019",
    citation:
      "Partanen, N., Hämäläinen, M., & Alnajjar, K. (2019). Dialect Text Normalization to Normative Standard Finnish. Proceedings of W-NUT 2019, 141-146.",
    url: "https://doi.org/10.18653/v1/D19-5519",
  },
  {
    key: "Podesva 2007",
    citation: "Podesva, R. J. (2007). Phonation type as a stylistic variable: The use of falsetto in constructing a persona. Journal of Sociolinguistics, 11(4), 478-504.",
    url: "https://doi.org/10.1111/j.1467-9841.2007.00334.x",
  },
  {
    key: "Radford et al. 2022",
    citation: "Radford, A., Kim, J. W., Xu, T., Brockman, G., McLeavey, C., & Sutskever, I. (2022). Robust Speech Recognition via Large-Scale Weak Supervision. arXiv:2212.04356.",
    url: "https://arxiv.org/abs/2212.04356",
  },
  {
    key: "Ramos Pinto 2009",
    citation: "Ramos Pinto, S. (2009). How important is the way you say it? A discussion on the translation of linguistic varieties. Target, 21(2), 289-307.",
    url: "https://doi.org/10.1075/target.21.2.04pin",
  },
  {
    key: "Rosa 2012",
    citation: "Rosa, A. A. (2012). Translating Place: Linguistic Variation in Translation. Word and Text, II(2), 75-97.",
    url: "https://jlsl.upg-ploiesti.ro/site_romana/Documente/Word_and_text_no_2_2012/05_Rosa.pdf",
  },
  {
    key: "Seamless 2023",
    citation: "Seamless Communication, Barrault, L., Chung, Y.-A., Coria Meglioli, M., et al. (2023). Seamless: Multilingual Expressive and Streaming Speech Translation. arXiv:2312.05187.",
    url: "https://arxiv.org/abs/2312.05187",
    note: "Preprint.",
  },
  {
    key: "Sennrich et al. 2016",
    citation: "Sennrich, R., Haddow, B., & Birch, A. (2016). Controlling Politeness in Neural Machine Translation via Side Constraints. Proceedings of NAACL-HLT 2016, 35-40.",
    url: "https://doi.org/10.18653/v1/N16-1005",
  },
  {
    key: "Sperber & Paulik 2020",
    citation: "Sperber, M., & Paulik, M. (2020). Speech Translation and the End-to-End Promise: Taking Stock of Where We Are. Proceedings of ACL 2020, 7409-7421.",
    url: "https://doi.org/10.18653/v1/2020.acl-main.661",
  },
  {
    key: "Sun et al. 2023",
    citation: "Sun, J., et al. (2023). Dialect-robust Evaluation of Generated Text. Proceedings of ACL 2023, 6010-6028.",
    url: "https://doi.org/10.18653/v1/2023.acl-long.331",
  },
  {
    key: "Sutton et al. 2019",
    citation:
      "Sutton, S., Foulkes, P., Kirk, D., & Lawson, S. (2019). Voice as a Design Material: Sociophonetic Inspired Design Strategies in Human-Computer Interaction. Proceedings of CHI 2019, 1-14.",
    url: "https://doi.org/10.1145/3290605.3300833",
  },
  {
    key: "Tamagawa et al. 2011",
    citation:
      "Tamagawa, R., Watson, C., Kuo, I.-H., MacDonald, B., & Broadbent, E. (2011). The Effects of Synthesized Voice Accents on User Perceptions of Robots. International Journal of Social Robotics, 3(3), 253-262.",
    url: "https://doi.org/10.1007/s12369-011-0100-4",
  },
  {
    key: "Tatman 2017",
    citation: "Tatman, R. (2017). Gender and Dialect Bias in YouTube's Automatic Captions. Proceedings of the First ACL Workshop on Ethics in NLP, 53-59.",
    url: "https://doi.org/10.18653/v1/W17-1606",
  },
  {
    key: "Toral 2019",
    citation: "Toral, A. (2019). Post-editese: an Exacerbated Translationese. Proceedings of MT Summit XVII, 273-281.",
    url: "https://aclanthology.org/W19-6627/",
  },
  {
    key: "Toury 1995",
    citation: "Toury, G. (1995). Descriptive Translation Studies and Beyond. Amsterdam: John Benjamins.",
    url: "https://tau.ac.il/~tarbut/Toury/works/dts.html",
  },
  {
    key: "Tsiamas et al. 2024",
    citation:
      "Tsiamas, I., Sperber, M., Finch, A., & Garg, S. (2024). Speech Is More Than Words: Do Speech-to-Text Translation Systems Leverage Prosody? Proceedings of WMT 2024, 1235-1257.",
    url: "https://aclanthology.org/2024.wmt-1.119",
  },
  {
    key: "Vanmassenhove et al. 2019",
    citation:
      "Vanmassenhove, E., Shterionov, D., & Way, A. (2019). Lost in Translation: Loss and Decay of Linguistic Richness in Machine Translation. Proceedings of MT Summit XVII, 222-232.",
    url: "https://aclanthology.org/W19-6622/",
  },
  {
    key: "Vanmassenhove et al. 2021",
    citation:
      "Vanmassenhove, E., Shterionov, D., & Gwilliam, M. (2021). Machine Translationese: Effects of Algorithmic Bias on Linguistic Complexity in Machine Translation. Proceedings of EACL 2021, 2203-2213.",
    url: "https://doi.org/10.18653/v1/2021.eacl-main.188",
  },
  {
    key: "Virkkunen et al. 2023",
    citation:
      "Virkkunen, A., Rouhe, A., Phan, N., & Kurimo, M. (2023). Finnish parliament ASR corpus: Analysis, benchmarks and statistics. Language Resources and Evaluation, 57(4), 1645-1670.",
    url: "https://doi.org/10.1007/s10579-023-09650-7",
  },
  {
    key: "Zhang et al. 2025",
    citation: "Zhang, R., Zhao, W., & Eger, S. (2025). How Good Are LLMs for Literary Translation, Really? Proceedings of NAACL 2025, 10961-10988.",
    url: "https://doi.org/10.18653/v1/2025.naacl-long.548",
  },
];

export const REFERENCE_BY_KEY: ReadonlyMap<string, Reference> = new Map(REFERENCES.map((ref) => [ref.key, ref]));
