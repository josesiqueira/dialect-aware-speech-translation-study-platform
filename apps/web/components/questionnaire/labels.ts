/**
 * Interface text of QuestionnaireForm (spec 100). The questions themselves come
 * from the questionnaire version in the database; these are only the words the
 * form adds around them. Pass the object for the participant's language.
 *
 * Placeholders in braces are replaced by the form: {count}, {min}, {max}.
 */
export interface QuestionnaireFormLabels {
  /** Added after the prompt of a required item, for example "(required)". */
  required: string;
  /** Helper line of a checkbox item. */
  selectAllThatApply: string;
  /** The two answers of a yes or no item. */
  yes: string;
  no: string;
  /** Announced above the form when a submit finds problems. {count} is the number of items. */
  errorSummary: string;
  errors: {
    /** A required item without an answer. */
    required: string;
    /** An answer that cannot be read (should not happen with the form's own controls). */
    invalid: string;
    /** A number item with something other than a whole number. */
    notInteger: string;
    /** A number outside {min} to {max}. */
    outOfRange: string;
    /** A number below {min} when there is no maximum. */
    atLeast: string;
    /** A number above {max} when there is no minimum. */
    atMost: string;
    /** Text longer than {max} characters. */
    tooLong: string;
  };
  /** Label of the submit button while onSubmit is pending. */
  submitting: string;
  /** Shown when onSubmit rejects. */
  submitFailed: string;
  /** Shown after a valid submit in readOnly mode: nothing was sent. */
  previewNotice: string;
}

export const QUESTIONNAIRE_FORM_LABELS_EN: QuestionnaireFormLabels = {
  required: "(required)",
  selectAllThatApply: "You can choose more than one.",
  yes: "Yes",
  no: "No",
  errorSummary: "Please check the marked questions ({count}).",
  errors: {
    required: "Please answer this question.",
    invalid: "Please check this answer.",
    notInteger: "Enter a whole number.",
    outOfRange: "Enter a number from {min} to {max}.",
    atLeast: "Enter a number that is {min} or more.",
    atMost: "Enter a number that is {max} or less.",
    tooLong: "The answer can be at most {max} characters long.",
  },
  submitting: "Sending...",
  submitFailed: "Your answers could not be sent. Please try again.",
  previewNotice: "Preview: the answers are valid and nothing was sent.",
};

export const QUESTIONNAIRE_FORM_LABELS_FI: QuestionnaireFormLabels = {
  required: "(pakollinen)",
  selectAllThatApply: "Voit valita useita.",
  yes: "Kyllä",
  no: "Ei",
  errorSummary: "Tarkista merkityt kysymykset ({count}).",
  errors: {
    required: "Vastaa tähän kysymykseen.",
    invalid: "Tarkista tämä vastaus.",
    notInteger: "Anna kokonaisluku.",
    outOfRange: "Anna luku väliltä {min}-{max}.",
    atLeast: "Anna luku, joka on vähintään {min}.",
    atMost: "Anna luku, joka on enintään {max}.",
    tooLong: "Vastaus voi olla enintään {max} merkkiä pitkä.",
  },
  submitting: "Lähetetään...",
  submitFailed: "Vastausten lähettäminen ei onnistunut. Yritä uudelleen.",
  previewNotice: "Esikatselu: vastaukset kelpaavat, eikä mitään lähetetty.",
};

export const QUESTIONNAIRE_FORM_LABELS: Record<"en" | "fi", QuestionnaireFormLabels> = {
  en: QUESTIONNAIRE_FORM_LABELS_EN,
  fi: QUESTIONNAIRE_FORM_LABELS_FI,
};
