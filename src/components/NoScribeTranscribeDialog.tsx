import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Label } from "./ui/label";
import { Toggle } from "./ui/toggle";
import { Button } from "./ui/button";
import {
  AudioLines,
  Copy,
  Check,
  ExternalLink,
  Languages,
  Loader2,
  Sparkles,
  Users,
} from "./icons";
import { cn } from "./lib/utils";
import type { NoteItem, TranscriptionItem as TranscriptionItemType } from "../types/electron";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const NO_SCRIBE_LANGUAGES: ReadonlyArray<{ code: string; label: string }> = [
  { code: "auto", label: "Auto" },
  { code: "multilingual", label: "Multilingual" },
  { code: "af", label: "Afrikaans" },
  { code: "ar", label: "Arabic" },
  { code: "hy", label: "Armenian" },
  { code: "az", label: "Azerbaijani" },
  { code: "be", label: "Belarusian" },
  { code: "bs", label: "Bosnian" },
  { code: "bg", label: "Bulgarian" },
  { code: "ca", label: "Catalan" },
  { code: "zh", label: "Chinese" },
  { code: "hr", label: "Croatian" },
  { code: "cs", label: "Czech" },
  { code: "da", label: "Danish" },
  { code: "nl", label: "Dutch" },
  { code: "en", label: "English" },
  { code: "et", label: "Estonian" },
  { code: "fi", label: "Finnish" },
  { code: "fr", label: "French" },
  { code: "gl", label: "Galician" },
  { code: "de", label: "German" },
  { code: "el", label: "Greek" },
  { code: "he", label: "Hebrew" },
  { code: "hi", label: "Hindi" },
  { code: "hu", label: "Hungarian" },
  { code: "is", label: "Icelandic" },
  { code: "id", label: "Indonesian" },
  { code: "it", label: "Italian" },
  { code: "ja", label: "Japanese" },
  { code: "kn", label: "Kannada" },
  { code: "kk", label: "Kazakh" },
  { code: "ko", label: "Korean" },
  { code: "lv", label: "Latvian" },
  { code: "lt", label: "Lithuanian" },
  { code: "mk", label: "Macedonian" },
  { code: "ms", label: "Malay" },
  { code: "mr", label: "Marathi" },
  { code: "mi", label: "Maori" },
  { code: "ne", label: "Nepali" },
  { code: "no", label: "Norwegian" },
  { code: "fa", label: "Persian" },
  { code: "pl", label: "Polish" },
  { code: "pt", label: "Portuguese" },
  { code: "ro", label: "Romanian" },
  { code: "ru", label: "Russian" },
  { code: "sr", label: "Serbian" },
  { code: "sk", label: "Slovak" },
  { code: "sl", label: "Slovenian" },
  { code: "es", label: "Spanish" },
  { code: "sw", label: "Swahili" },
  { code: "sv", label: "Swedish" },
  { code: "tl", label: "Tagalog" },
  { code: "ta", label: "Tamil" },
  { code: "th", label: "Thai" },
  { code: "tr", label: "Turkish" },
  { code: "uk", label: "Ukrainian" },
  { code: "ur", label: "Urdu" },
  { code: "vi", label: "Vietnamese" },
  { code: "cy", label: "Welsh" },
];

interface NoScribeTranscribeDialogProps {
  open: boolean;
  item: TranscriptionItemType | null;
  onOpenChange: (open: boolean) => void;
  onCopy: (text: string) => void;
  note?: NoteItem | null;
  onTranscribed?: (transcript: string) => void;
  audioSources?: { transcriptionId: number; fileName: string | null; available: boolean }[];
}

type Stage = "loading" | "configure" | "not-installed" | "running" | "result" | "error";

export default function NoScribeTranscribeDialog({
  open,
  item,
  onOpenChange,
  onCopy,
  note,
  onTranscribed,
  audioSources = [],
}: NoScribeTranscribeDialogProps) {
  const { t } = useTranslation();
  const [stage, setStage] = useState<Stage>("loading");
  const [available, setAvailable] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [language, setLanguage] = useState("auto");
  const [speakerDetection, setSpeakerDetection] = useState("auto");
  const [timestamps, setTimestamps] = useState(false);
  const [disfluencies, setDisfluencies] = useState(true);
  const [overlapping, setOverlapping] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [transcriptionId, setTranscriptionId] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [progress, setProgress] = useState<{
    stage: string;
    bytes?: number;
    recordingIndex?: number;
    recordingCount?: number;
  } | null>(null);
  const requestIdRef = useRef<string | null>(null);
  const progressUnsubRef = useRef<(() => void) | null>(null);

  const reset = useCallback(() => {
    setStage("loading");
    setError(null);
    setTranscript("");
    setTranscriptionId(null);
    setCopied(false);
    setProgress(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    reset();
    const run = async () => {
      try {
        const status = await window.electronAPI.getNoScribeStatus();
        if (!status.available) {
          setStage("not-installed");
          return;
        }
        const listed = await window.electronAPI.listNoScribeModels();
        const all = listed.length > 0 ? listed : ["precise", "fast"];
        setModels(all);
        setModel(all.includes("precise") ? "precise" : all[0]);
        setStage("configure");
      } catch {
        setStage("not-installed");
      }
    };
    void run();
  }, [open, reset]);

  const cancelRunning = useCallback(() => {
    if (requestIdRef.current) {
      void window.electronAPI.cancelNoScribeTranscription(requestIdRef.current);
      requestIdRef.current = null;
    }
    progressUnsubRef.current?.();
    progressUnsubRef.current = null;
  }, []);

  useEffect(() => {
    return () => cancelRunning();
  }, [cancelRunning]);

  const handleTranscribe = useCallback(async () => {
    const sourceId = note ? note.id : item?.id ?? null;
    if (sourceId == null) return;
    const requestId = crypto.randomUUID();
    requestIdRef.current = requestId;
    setError(null);
    setProgress(null);
    setStage("running");
    const unsubscribe = window.electronAPI.onNoScribeProgress((info) => {
      if (info.requestId !== requestId) return;
      setProgress(info);
    });
    progressUnsubRef.current = unsubscribe;
    try {
      const result = await window.electronAPI.transcribeWithNoScribe(sourceId, {
        requestId,
        language,
        model,
        speakerDetection,
        timestamps,
        disfluencies,
        overlapping,
        noteId: note ? note.id : undefined,
      });
      unsubscribe();
      progressUnsubRef.current = null;
      requestIdRef.current = null;
      if (result.success && result.transcript) {
        setTranscript(result.transcript);
        setTranscriptionId(result.transcriptionId ?? null);
        setStage("result");
        onTranscribed?.(result.transcript);
      } else if (result.code === "NO_SCRIBE_CANCELED") {
        setStage("configure");
      } else {
        setError(result.error || t("noscribe.errorGeneric"));
        setStage("error");
      }
    } catch (err) {
      unsubscribe();
      progressUnsubRef.current = null;
      requestIdRef.current = null;
      setError(err instanceof Error ? err.message : String(err));
      setStage("error");
    }
  }, [note, item, language, model, speakerDetection, timestamps, disfluencies, overlapping, t, onTranscribed]);

  const handleCancel = useCallback(() => {
    cancelRunning();
    setStage("configure");
  }, [cancelRunning]);

  const handleOpenInNoScribe = useCallback(async () => {
    const sourceId = note ? note.id : item?.id ?? null;
    if (sourceId == null) return;
    try {
      const result = await window.electronAPI.openNoScribeFile(sourceId, {
        model,
        speakerDetection,
        noteId: note ? note.id : undefined,
      });
      if (result.success) {
        onOpenChange(false);
      } else if (result.code === "NO_SCRIBE_NOT_FOUND") {
        setStage("not-installed");
      } else {
        setError(result.error || t("noscribe.errorOpen"));
        setStage("error");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage("error");
    }
  }, [note, item, model, speakerDetection, onOpenChange, t]);

  const handleCopy = useCallback(async () => {
    await onCopy(transcript);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [transcript, onCopy]);

  const speakerLabel = (value: string) => {
    if (value === "auto") return t("noscribe.speakerAuto");
    if (value === "none") return t("noscribe.speakerNone");
    return value;
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !(stage === "running") && onOpenChange(next)}>
      <DialogContent
        className="max-w-xl"
        onEscapeKeyDown={(event) => {
          if (stage === "running") event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles size={16} className="text-primary" />
            {t("noscribe.title")}
          </DialogTitle>
          <DialogDescription>{t("noscribe.description")}</DialogDescription>
        </DialogHeader>

        {stage === "loading" && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 size={15} className="animate-spin text-primary" />
            {t("noscribe.checking")}
          </div>
        )}

        {stage === "not-installed" && (
          <div className="space-y-4 py-2">
            <p className="text-sm leading-relaxed text-muted-foreground">
              {t("noscribe.notInstalled")}
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground/80">
              {t("noscribe.notInstalledHint")}
            </p>
            <div className="flex gap-2">
              <Button variant="default" size="sm" onClick={() => onOpenChange(false)}>
                {t("common.close")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void window.electronAPI.openExternal("https://noscribe.de")}
              >
                <ExternalLink size={14} className="me-1.5" />
                {t("noscribe.download")}
              </Button>
            </div>
          </div>
        )}

        {stage === "configure" && (
          <div className="space-y-4 py-1">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="noscribe-language">{t("noscribe.language")}</Label>
                <Select value={language} onValueChange={setLanguage}>
                  <SelectTrigger id="noscribe-language" className="w-full">
                    <SelectValue placeholder={t("noscribe.language")} />
                  </SelectTrigger>
                  <SelectContent>
                    {NO_SCRIBE_LANGUAGES.map((lang) => (
                      <SelectItem key={lang.code} value={lang.code}>
                        <span className="flex items-center gap-2">
                          <Languages size={13} className="text-muted-foreground" />
                          {lang.label}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="noscribe-model">{t("noscribe.model")}</Label>
                <Select value={model} onValueChange={setModel} disabled={models.length === 0}>
                  <SelectTrigger id="noscribe-model" className="w-full">
                    <SelectValue placeholder={t("noscribe.model")} />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((name) => (
                      <SelectItem key={name} value={name}>
                        <span className="flex items-center gap-2">
                          <AudioLines size={13} className="text-muted-foreground" />
                          {name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {note && audioSources.length > 1 && (
              <div className="flex items-start gap-2 rounded-xl border border-border/70 bg-surface-1 px-3.5 py-2.5 text-xs leading-relaxed text-muted-foreground dark:bg-surface-3">
                <AudioLines size={13} className="mt-0.5 shrink-0 text-primary" />
                <span>
                  {t("noscribe.multipleRecordings", {
                    count: audioSources.length,
                  })}
                </span>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="noscribe-speakers">{t("noscribe.speakers")}</Label>
              <Select value={speakerDetection} onValueChange={setSpeakerDetection}>
                <SelectTrigger id="noscribe-speakers" className="w-full">
                  <SelectValue placeholder={t("noscribe.speakers")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{speakerLabel("auto")}</SelectItem>
                  <SelectItem value="none">{speakerLabel("none")}</SelectItem>
                  {Array.from({ length: 10 }, (_, i) => (i + 1).toString()).map((count) => (
                    <SelectItem key={count} value={count}>
                      <span className="flex items-center gap-2">
                        <Users size={13} className="text-muted-foreground" />
                        {speakerLabel(count)}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2.5 rounded-xl border border-border/70 p-3.5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {t("noscribe.disfluencies")}
                  </p>
                  <p className="text-xs text-muted-foreground">{t("noscribe.disfluenciesHint")}</p>
                </div>
                <Toggle checked={disfluencies} onChange={setDisfluencies} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-foreground">{t("noscribe.overlapping")}</p>
                  <p className="text-xs text-muted-foreground">{t("noscribe.overlappingHint")}</p>
                </div>
                <Toggle checked={overlapping} onChange={setOverlapping} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-foreground">{t("noscribe.timestamps")}</p>
                  <p className="text-xs text-muted-foreground">{t("noscribe.timestampsHint")}</p>
                </div>
                <Toggle checked={timestamps} onChange={setTimestamps} />
              </div>
            </div>
          </div>
        )}

        {stage === "running" && (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-2.5 rounded-xl border border-primary/20 bg-primary/5 px-3.5 py-3">
              <Loader2 size={16} className="animate-spin text-primary" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">{t("noscribe.running")}</p>
                <p className="text-xs text-muted-foreground">
                  {progress?.stage === "writing"
                    ? t("noscribe.writingTranscript")
                    : t("noscribe.processingAudio")}
                </p>
                {progress?.recordingCount != null &&
                  progress.recordingCount > 1 &&
                  progress.recordingIndex != null && (
                    <p className="text-xs text-muted-foreground">
                      {t("noscribe.recordingOf", {
                        current: progress.recordingIndex,
                        total: progress.recordingCount,
                      })}
                    </p>
                  )}
                {progress?.stage === "writing" && (progress.bytes ?? 0) > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {t("noscribe.writtenBytes", { size: formatFileSize(progress.bytes ?? 0) })}
                  </p>
                )}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t("noscribe.runningHint")}</p>
          </div>
        )}

        {stage === "result" && (
          <div className="space-y-3 py-1">
            <div className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-xl border border-border/70 bg-surface-1 p-3.5 text-sm leading-relaxed text-foreground dark:bg-surface-3">
              {transcript}
            </div>
            {transcriptionId != null && (
              <p className="text-xs text-muted-foreground">
                {note ? t("noscribe.savedToNote") : t("noscribe.savedToHistory")}
              </p>
            )}
          </div>
        )}

        {stage === "error" && (
          <div className="space-y-3 rounded-xl border border-destructive/25 bg-destructive/5 px-3.5 py-3">
            <p className="text-sm leading-relaxed text-destructive">{error}</p>
          </div>
        )}

        {(stage === "configure" || stage === "error") && (
          <div className="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            <Button
              variant="outline"
              size="sm"
              onClick={handleOpenInNoScribe}
              title={t("noscribe.openAppHint")}
            >
              <ExternalLink size={14} className="me-1.5" />
              {t("noscribe.openApp")}
            </Button>
            <div className="flex gap-2">
              {stage === "configure" && (
                <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                  {t("common.cancel")}
                </Button>
              )}
              {stage === "error" && (
                <Button variant="ghost" size="sm" onClick={() => setStage("configure")}>
                  {t("common.back")}
                </Button>
              )}
              <Button variant="default" size="sm" onClick={handleTranscribe}>
                <Sparkles size={14} className="me-1.5" />
                {t("noscribe.transcribe")}
              </Button>
            </div>
          </div>
        )}

        {stage === "running" && (
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={handleCancel}>
              {t("common.cancel")}
            </Button>
          </div>
        )}

        {stage === "result" && (
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            <Button
              variant="default"
              size="sm"
              onClick={handleCopy}
              className={cn(copied && "bg-emerald-600 text-white")}
            >
              {copied ? (
                <Check size={14} className="me-1.5" />
              ) : (
                <Copy size={14} className="me-1.5" />
              )}
              {copied ? t("common.copied") : t("controlPanel.history.copyText")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {t("common.close")}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
