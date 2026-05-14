const axios = require("axios");

async function translateToItalian(text) {
  if (!text) return "";

  try {
    const res = await axios.get(
      "https://api.mymemory.translated.net/get",
      {
        params: {
          q: text,
          langpair: "en|it"
        }
      }
    );

    return res.data.responseData.translatedText || text;

  } catch (err) {
    console.log("Errore traduzione:", err.message);
    return text; // fallback sicuro
  }
}

module.exports = { translateToItalian };