import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import uz from "./locales/uz.json";

export const LOCALE_KEY = "magi_locale";

void i18next.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    uz: { translation: uz },
  },
  lng: localStorage.getItem(LOCALE_KEY) || "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export default i18next;
