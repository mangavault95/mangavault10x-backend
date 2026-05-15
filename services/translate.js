const fetch = global.fetch;

async function translateToItalian(text) {
  if (!text) return "");

  try {
    const response = await fetch("https://api.mymemory.translated.net/get?q=" 
      + encodeURIComponent(text) + "&langpair=en|it"
    );

    const data = await response.json();

    const translated = data?.responseData?.translatedText;

    // ✅ fallback se API fallisce o ritorna roba strana
    if (
      !translated ||
      translated.includes("QUERY LENGTH") ||
      translated.length < 10
    ) {
      return text;
    }

    return translated;

  } catch (err) {
    console.error("❌ ERRORE TRADUZIONE:", err);
    return text;
  }
}

module.exports = { translateToItalian };
