/**
 * Spoken guidance through the Web Speech API. Mobile browsers only allow
 * speech that was "unlocked" by a user gesture, so `unlock()` is called from
 * the 開始導航 tap; everything after that can speak freely.
 */
class Voice {
  private muted = false;
  private voice: SpeechSynthesisVoice | null = null;
  private lastText = "";
  private lastAt = 0;

  get supported() {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  }

  unlock() {
    if (!this.supported) return;
    try {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      window.speechSynthesis.speak(u);
    } catch {
      /* ignore */
    }
    this.pickVoice();
    window.speechSynthesis.onvoiceschanged = () => this.pickVoice();
  }

  private pickVoice() {
    const voices = window.speechSynthesis.getVoices();
    this.voice =
      voices.find((v) => v.lang === "zh-TW" && /Mei-Jia|美佳/i.test(v.name)) ??
      voices.find((v) => v.lang === "zh-TW") ??
      voices.find((v) => v.lang.startsWith("zh")) ??
      null;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (m && this.supported) window.speechSynthesis.cancel();
  }

  get isMuted() {
    return this.muted;
  }

  speak(text: string, opts: { interrupt?: boolean } = {}) {
    if (!this.supported || this.muted || !text) return;
    // the guidance loop re-derives text every fix; never repeat the same line
    if (text === this.lastText && Date.now() - this.lastAt < 8000) return;
    this.lastText = text;
    this.lastAt = Date.now();
    if (opts.interrupt) window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "zh-TW";
    u.rate = 1.05;
    if (this.voice) u.voice = this.voice;
    window.speechSynthesis.speak(u);
  }
}

export const voice = new Voice();
