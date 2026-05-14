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

    const translated = res.data?.responseData?.translatedText;

if (
  !translated ||
  translated.includes("QUERY LENGTH LIMIT")
) {
  return text; // fallback
}

return translated;

  } catch (err) {
    console.log("Errore traduzione:", err.message);
    return text; // fallback sicuro
  }
}

module.exports = { translateToItalian };
