import { useEffect, useState } from "react";
import { getManga } from "../services/api";

export default function AdminPage() {
  const [mangaList, setMangaList] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState(localStorage.getItem("token"));

  async function login(username, password) {
    const res = await fetch(`${import.meta.env.VITE_API_URL}/api/manga/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username, password }),
    });

    const data = await res.json();

    if (data.token) {
      localStorage.setItem("token", data.token);
      setToken(data.token);
    } else {
      alert("Login fallito");
    }
  }

  useEffect(() => {
    loadManga();
  }, []);

  async function loadManga() {
    setLoading(true);
    try {
      const data = await getManga();
      setMangaList(data || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function saveChanges() {
    if (!selected) return;

    try {
      const id = selected.Id || selected.ID;

      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/api/manga/${id}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            coverurl: selected.CoverURL,
            trama: selected.Trama,
            volumiposseduti: selected.VolumiPosseduti,
            volumitotali: selected.VolumiTotali,
          }),
        }
      );

      if (!res.ok) throw new Error("Errore HTTP");

      const data = await res.json();

      if (data.success) {
        alert("Salvato correttamente!");
        await loadManga();
      }
    } catch (err) {
      console.error(err);
      alert("Errore server");
    }
  }

  // ✅ ENRICH FIXATO
  async function enrichManga() {
    if (!selected) return;

    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/api/manga/enrich`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            titolo: selected.Titolo,
          }),
        }
      );

      const data = await res.json();

      // ✅ ERRORE GESTITO
      if (data.error) {
        alert(data.error);
        return;
      }

      // ✅ UPDATE DATI
      setSelected({
        ...selected,
        Titolo: data.titolo || selected.Titolo,
        Trama: data.trama || selected.Trama,
        CoverURL: data.coverurl || selected.CoverURL,
        VolumiTotali: data.volumitotali || selected.VolumiTotali,
      });

    } catch (err) {
      console.error(err);
      alert("Errore enrich");
    }
  }

  // LOGIN
  if (!token) {
    return (
      <div className="h-screen flex items-center justify-center bg-black text-white">
        <div className="bg-zinc-900 p-6 rounded-xl space-y-4">
          <h2 className="text-xl font-bold">Login Admin</h2>

          <input id="user" placeholder="Username" className="w-full p-2 bg-zinc-800" />
          <input id="pass" type="password" placeholder="Password" className="w-full p-2 bg-zinc-800" />

          <button
            onClick={() =>
              login(
                document.getElementById("user").value,
                document.getElementById("pass").value
              )
            }
            className="bg-green-600 px-4 py-2 w-full"
          >
            Login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex">
      {/* SIDEBAR */}
      <div className="w-72 h-screen bg-black/60 border-r border-zinc-800 overflow-y-auto">
        <h1 className="text-2xl font-bold p-5">Admin MangaVault</h1>

        <div className="px-5 pb-3">
          <button
            onClick={() => (window.location.href = "/")}
            className="w-full py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 transition text-sm font-semibold"
          >
            ← Torna alla Home
          </button>
        </div>

        {loading ? (
          <div className="p-4 text-zinc-400">Caricamento...</div>
        ) : (
          mangaList.map((m, i) => (
            <div
              key={m.Id || m.ID || i}
              onClick={() => setSelected(m)}
              className="p-3 border-b border-zinc-800 cursor-pointer hover:bg-zinc-900"
            >
              {m.Titolo}
            </div>
          ))
        )}
      </div>

      {/* CONTENT */}
      <div className="flex-1 p-8">
        {!selected ? (
          <div className="text-zinc-400">Seleziona un manga</div>
        ) : (
          <>
            <div className="max-w-5xl">
              <div className="flex gap-8">

                {/* COVER */}
                <div className="w-64">
                  <img
                    src={
                      selected.CoverURL && selected.CoverURL !== "NULL"
                        ? selected.CoverURL
                        : "https://placehold.co/300x450"
                    }
                    className="w-full h-[380px] object-cover rounded-xl"
                    alt="cover"
                  />
                </div>

                {/* FORM */}
                <div className="flex-1 space-y-4">

                  <input
                    className="w-full p-3 bg-zinc-900 border border-zinc-800 rounded-xl text-white"
                    value={selected.Titolo || ""}
                    onChange={(e) =>
                      setSelected({ ...selected, Titolo: e.target.value })
                    }
                  />

                  <input
                    className="w-full p-3 bg-zinc-900 border border-zinc-800 rounded-xl text-white"
                    value={selected.Autore || ""}
                    onChange={(e) =>
                      setSelected({ ...selected, Autore: e.target.value })
                    }
                  />

                  <input
                    className="w-full p-3 bg-zinc-900 border border-zinc-800 rounded-xl text-white"
                    value={selected.CoverURL || ""}
                    onChange={(e) =>
                      setSelected({ ...selected, CoverURL: e.target.value })
                    }
                  />

                  <textarea
                    className="w-full p-4 bg-zinc-900 border border-zinc-800 rounded-xl h-56 text-white"
                    value={selected.Trama || ""}
                    onChange={(e) =>
                      setSelected({ ...selected, Trama: e.target.value })
                    }
                  />

                </div>
              </div>
            </div>

            {/* BUTTONS */}
            <div className="flex gap-4 mt-6">
              <button
                onClick={saveChanges}
                className="bg-green-600 px-6 py-3 rounded-xl"
              >
                Salva
              </button>

              <button
                onClick={enrichManga}
                className="bg-blue-600 hover:bg-blue-700 px-6 py-3 rounded-xl transition"
              >
                Auto Enrich
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
