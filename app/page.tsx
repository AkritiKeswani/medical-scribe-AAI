"use client";

import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Mic, Loader2, Play, Square, RotateCcw, Activity, Sparkles } from "lucide-react";

// Initial empty SOAP structure
const INITIAL_SOAP_STATE = {
  subjective: [] as string[],
  objective: [] as string[],
  assessment: [] as string[],
  plan: [] as string[],
  open_questions: [] as string[]
};

export default function ScribeDemo() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  
  // Transcript state
  const [finalizedChunks, setFinalizedChunks] = useState<string[]>([]);
  const [partialChunk, setPartialChunk] = useState("");
  
  // SOAP state
  const [soapState, setSoapState] = useState(INITIAL_SOAP_STATE);
  const soapStateRef = useRef(soapState);
  
  const scrollRef = useRef<HTMLDivElement>(null);
  
  // Audio & WebSocket refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const updateQueueRef = useRef<Promise<void>>(Promise.resolve());

  // Keep ref synchronized with state to ensure the updateQueue always uses the latest state
  useEffect(() => {
    soapStateRef.current = soapState;
  }, [soapState]);

  // Scroll to bottom of transcript when it updates
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [finalizedChunks, partialChunk]);

  // Handle cleanup on unmount
  useEffect(() => {
    return () => {
      stopRecording();
    };
  }, []);

  const triggerSoapUpdate = (newChunk: string) => {
    setIsUpdating(true);
    
    // Process updates strictly sequentially so we don't overwrite changes
    updateQueueRef.current = updateQueueRef.current.then(async () => {
        try {
            const response = await fetch('/api/update-soap', {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json' },
                 body: JSON.stringify({
                     currentState: soapStateRef.current,
                     newChunk
                 })
            });
            if (response.ok) {
                const newState = await response.json();
                setSoapState(newState);
            } else {
                console.error("SOAP update returned non-OK status");
            }
        } catch (e) {
            console.error("Failed to update SOAP", e);
        }
    }).finally(() => {
        setIsUpdating((prev) => {
             // Ideally we'd only set this to false if the queue is fully drained, 
             // but setting it false after each task is generally fine for UI indicators.
             return false;
        });
    });
  };

  const finalizeSoap = async () => {
    if (finalizedChunks.length === 0 || isFinalizing) return;
    setIsFinalizing(true);
    setErrorMsg(null);
    try {
        // Wait for any in-flight live patches so they can't overwrite the finalize result.
        await updateQueueRef.current;

        const transcript = finalizedChunks.join(' ');
        const response = await fetch('/api/finalize-soap', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transcript }),
        });
        if (!response.ok) {
            setErrorMsg('Failed to finalize SOAP note');
            return;
        }
        const newState = await response.json();
        setSoapState(newState);
    } catch (e) {
        const errorDetails = e instanceof Error ? e.message : String(e);
        setErrorMsg(`Finalize failed: ${errorDetails}`);
    } finally {
        setIsFinalizing(false);
    }
  };

  const startRecording = async () => {
    try {
        setErrorMsg(null);
        const response = await fetch('/api/token');
        const data = await response.json();
        const token = data.token;

        if (!token || data.error) {
            setErrorMsg('Missing AssemblyAI API Key. Please add ASSEMBLYAI_API_KEY to your AI Studio secrets.');
            return;
        }

        // Connect to AssemblyAI Universal-Streaming v3.
        // format_turns=true returns punctuated/cased text on end-of-turn messages.
        const wsUrl = `wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&token=${token}&format_turns=true`;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = async () => {
            setIsPlaying(true);
            
            // Request microphone permissions and stream audio
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;

            // Use Web Audio API to process raw audio
            const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
            const context = new AudioContext({ sampleRate: 16000 });
            audioContextRef.current = context;

            const source = context.createMediaStreamSource(stream);
            sourceRef.current = source;

            // ScriptProcessorNode handles raw audio blocks (deprecated but still standard for this use case)
            const processor = context.createScriptProcessor(4096, 1, 1);
            processorRef.current = processor;

            source.connect(processor);
            processor.connect(context.destination);

            processor.onaudioprocess = (e) => {
                const inputData = e.inputBuffer.getChannelData(0);

                // Float32 [-1,1] -> Int16 little-endian PCM.
                // v3 expects raw binary frames (no JSON, no base64).
                const pcm16 = new Int16Array(inputData.length);
                for (let i = 0; i < inputData.length; i++) {
                    const s = Math.max(-1, Math.min(1, inputData[i]));
                    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }

                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(pcm16.buffer);
                }
            };
        };

        ws.onmessage = (event) => {
            const res = JSON.parse(event.data);

            // v3 sends: Begin | Turn | Termination
            // With format_turns=true, each turn yields multiple Turn messages.
            // We only finalize on end_of_turn && turn_is_formatted so the SOAP
            // update fires once per turn against the cleanest text.
            if (res.type === 'Begin') {
                console.log('AssemblyAI Universal-Streaming session started:', res.id);
            } else if (res.type === 'Turn') {
                const transcript: string = res.transcript || '';
                if (!res.end_of_turn) {
                    setPartialChunk(transcript);
                } else if (res.turn_is_formatted) {
                    setPartialChunk('');
                    if (transcript) {
                        setFinalizedChunks(prev => [...prev, transcript]);
                        triggerSoapUpdate(transcript);
                    }
                }
            } else if (res.type === 'Termination') {
                console.log('AssemblyAI session terminated');
            } else if (res.error) {
                console.error('AssemblyAI Error:', res.error);
            }
        };

        ws.onerror = (e) => console.error("WS Error", e);
        ws.onclose = () => {
           setIsPlaying(false);
           stopRecording(); // Cleanup
        };

    } catch (e) {
        console.error("Recording error:", e);
        const errorDetails = e instanceof Error ? e.message : String(e);
        setErrorMsg(`Failed to start: ${errorDetails}`);
        stopRecording();
    }
  };

  const stopRecording = () => {
    setIsPlaying(false);
    setPartialChunk("");
    if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
    }
    if (processorRef.current) {
        processorRef.current.disconnect();
        processorRef.current = null;
    }
    if (sourceRef.current) {
        sourceRef.current.disconnect();
        sourceRef.current = null;
    }
    if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
    }
    if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
    }
  };

  const handleReset = () => {
    stopRecording();
    setFinalizedChunks([]);
    setPartialChunk("");
    setSoapState(INITIAL_SOAP_STATE);
  };


  return (
    <div className="min-h-screen bg-slate-950 font-sans text-slate-200 selection:bg-sky-500/30 overflow-x-hidden">
      
      {/* Navbar */}
      <header className="sticky top-0 z-10 flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/50 backdrop-blur-md">
        <div className="flex items-center gap-4">
          <div className="w-8 h-8 rounded-lg bg-sky-500 flex items-center justify-center text-white shadow-sm">
            <div className="w-4 h-4 border-2 border-white rounded-sm"></div>
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-slate-200">Realtime Internal Medicine Scribe</h1>
            <p className="text-xs text-slate-500 hidden sm:block">Next.js + TypeScript + AI Streaming Engine</p>
          </div>
          <span className="hidden md:inline-flex px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-sky-500/10 text-sky-400 border border-sky-500/20 rounded-full">
            Streaming AI Demo
          </span>
        </div>
        <div className="flex items-center gap-3">
          {errorMsg && (
            <div className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 px-3 py-1.5 rounded-md max-w-sm truncate mr-2" title={errorMsg}>
               {errorMsg}
            </div>
          )}
          {!isPlaying && (
            <button onClick={startRecording} className="px-4 py-2 text-sm font-medium bg-sky-600 hover:bg-sky-500 text-white rounded-md transition-all shadow-lg shadow-sky-900/20 flex items-center gap-2">
              <Play className="w-4 h-4" fill="currentColor" />
              <span className="hidden sm:inline">Start Recording</span>
            </button>
          )}
          {isPlaying && (
            <button onClick={stopRecording} className="px-4 py-2 text-sm font-medium bg-slate-800 text-sky-400 hover:bg-slate-700 rounded-md border border-slate-700 transition-colors flex items-center gap-2 shadow-sm">
              <Square className="w-4 h-4" fill="currentColor" />
              <span className="hidden sm:inline">Stop Recording</span>
            </button>
          )}
          {!isPlaying && finalizedChunks.length > 0 && (
            <button
              onClick={finalizeSoap}
              disabled={isFinalizing}
              className="px-4 py-2 text-sm font-medium bg-purple-600 hover:bg-purple-500 disabled:bg-purple-900 disabled:cursor-not-allowed text-white rounded-md transition-all shadow-lg shadow-purple-900/20 flex items-center gap-2"
            >
              {isFinalizing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
              <span className="hidden sm:inline">{isFinalizing ? 'Finalizing…' : 'Finalize SOAP Note'}</span>
            </button>
          )}
          <button onClick={handleReset} className="px-4 py-2 text-sm font-medium bg-slate-800 text-slate-200 hover:bg-slate-700 rounded-md border border-slate-700 transition-colors flex items-center gap-2 shadow-sm">
            <RotateCcw className="w-4 h-4" />
            <span className="hidden sm:inline">Reset</span>
          </button>
        </div>
      </header>

      {/* Main Layout */}
      <main className="w-full max-w-7xl mx-auto p-4 md:p-6 lg:p-8">
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 min-h-[600px]">
          
          {/* Left Panel: Live Transcript */}
          <section className="xl:col-span-5 flex flex-col bg-slate-900/80 rounded-xl border border-slate-800 overflow-hidden shadow-2xl h-full max-h-[800px]">
            <div className="px-5 py-4 border-b border-slate-800 flex justify-between items-center bg-slate-900">
              <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-400 flex items-center gap-2">
                <Mic className="w-4 h-4 text-slate-500" />
                Live Transcript
              </h2>
              {isPlaying ? (
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></div>
                  <span className="text-[10px] text-slate-400 font-mono tracking-tighter">LIVE</span>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-slate-700"></div>
                  <span className="text-[10px] text-slate-500 font-mono tracking-tighter">STOPPED</span>
                </div>
              )}
            </div>
            
            <div className="flex-1 relative overflow-hidden">
              <ScrollArea className="h-[400px] lg:h-[600px] p-5">
                <div ref={scrollRef} className="space-y-4 pb-20">
                  <AnimatePresence>
                    {finalizedChunks.map((chunk, i) => (
                      <motion.p
                        key={i}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="text-slate-300 leading-relaxed text-sm"
                      >
                        {chunk}
                      </motion.p>
                    ))}
                  </AnimatePresence>
                  
                  {partialChunk && (
                    <motion.p
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="text-slate-500 leading-relaxed text-sm italic animate-pulse"
                    >
                      {partialChunk}
                      <motion.span
                        animate={{ opacity: [1, 0, 1] }}
                        transition={{ repeat: Infinity, duration: 1 }}
                        className="inline-block w-1.5 h-3.5 ml-1 bg-sky-500 align-middle"
                      />
                    </motion.p>
                  )}

                  {!isPlaying && finalizedChunks.length === 0 && (
                     <div className="h-full flex flex-col items-center justify-center text-slate-600 gap-4 mt-20">
                       <Mic className="w-12 h-12 opacity-20" />
                       <p className="text-sm font-medium">Click Start Recording to begin dictation</p>
                     </div>
                  )}
                </div>
              </ScrollArea>
              
              {/* Fade out bottom edge */}
              <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-slate-950/80 to-transparent pointer-events-none" />
            </div>
          </section>

          {/* Right Panel: SOAP Note */}
          <section className="xl:col-span-7 flex flex-col bg-slate-900/80 rounded-xl border border-slate-800 overflow-hidden shadow-2xl h-full max-h-[800px]">
            <div className="px-5 py-4 border-b border-slate-800 flex justify-between items-center bg-slate-900">
              <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-400 flex items-center gap-2">
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" className="text-sky-500">
                  <path d="M1.5 3C1.22386 3 1 3.22386 1 3.5C1 3.77614 1.22386 4 1.5 4H13.5C13.7761 4 14 3.77614 14 3.5C14 3.22386 13.7761 3 13.5 3H1.5ZM1 7.5C1 7.22386 1.22386 7 1.5 7H13.5C13.7761 7 14 7.22386 14 7.5C14 7.77614 13.7761 8 13.5 8H1.5C1.22386 8 1 7.77614 1 7.5ZM1 11.5C1 11.2239 1.22386 11 1.5 11H13.5C13.7761 11 14 11.2239 14 11.5C14 11.7761 13.7761 12 13.5 12H1.5C1.22386 12 1 11.7761 1 11.5Z" fill="currentColor" fillRule="evenodd" clipRule="evenodd"></path>
                </svg>
                Automated SOAP Note
              </h2>
              <div className="px-2 py-1 bg-slate-800 rounded text-[10px] text-slate-500 font-mono tracking-widest">
                 v2.4 ENGINE
              </div>
            </div>
            
            <div className="flex-1 overflow-hidden relative">
              <ScrollArea className="h-[400px] lg:h-[600px] p-6">
                
                  <div className="space-y-8 pb-12">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                      <SoapSection title="S" label="Subjective" items={soapState.subjective} colorTheme="sky" />
                      <SoapSection title="O" label="Objective" items={soapState.objective} colorTheme="emerald" />
                      <SoapSection title="A" label="Assessment" items={soapState.assessment} colorTheme="purple" />
                      <SoapSection title="P" label="Plan" items={soapState.plan} colorTheme="amber" />
                    </div>

                    <AnimatePresence>
                      {soapState.open_questions && soapState.open_questions.length > 0 && (
                         <motion.div 
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="mt-4 pt-6 border-t border-slate-800"
                        >
                          <h4 className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em] mb-3 flex items-center gap-2">
                             <svg className="w-3 h-3 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.44.54h1.002"></path></svg>
                             Suggested Clarifications
                          </h4>
                          <div className="flex flex-wrap gap-2">
                            {soapState.open_questions.map((q, idx) => (
                                <span key={idx} className="text-[11px] px-2 py-1 bg-sky-950/40 text-sky-300 rounded border border-sky-500/20 hover:bg-sky-500/20 cursor-pointer shadow-sm transition-colors">
                                  {q}
                                </span>
                            ))}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>

              </ScrollArea>
              
               {isPlaying && (
                  <div className="absolute top-4 right-6 pointer-events-none">
                     <Loader2 className="w-4 h-4 animate-spin text-slate-600" />
                  </div>
               )}
            </div>
          </section>
        </div>

        {/* Architecture Notes */}
        <footer className="mt-8">
          <div className="bg-sky-950/30 border border-sky-500/20 rounded-lg p-4 flex items-start gap-4">
            <div className="bg-sky-500/20 p-2 rounded-md shrink-0">
               <svg className="w-5 h-5 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                 <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
               </svg>
            </div>
            <div>
               <h5 className="text-xs font-bold text-sky-200 uppercase tracking-wide">Architecture Notes</h5>
               <p className="text-sm text-sky-400/80 mt-1.5 leading-relaxed">
                 Each finalized transcript chunk acts as an event that incrementally updates structured clinical state. audio is streamed continuously via WebSockets to AssemblyAI's <span className="text-sky-300 font-mono text-xs">Universal-1</span> model. When a chunk finalizes, it triggers a background LLM process to dynamically patch the JSON object without disrupting the live audio flow.
               </p>
            </div>
          </div>
        </footer>

      </main>
    </div>
  );
}

function SoapSection({ title, label, items, colorTheme }: { title: string; label: string; items: string[], colorTheme: 'sky' | 'emerald' | 'purple' | 'amber' }) {
  const themes = {
    sky: "text-sky-400 bg-sky-400/10 border-sky-500/50",
    emerald: "text-emerald-400 bg-emerald-400/10 border-emerald-500/50",
    purple: "text-purple-400 bg-purple-400/10 border-purple-500/50",
    amber: "text-amber-400 bg-amber-400/10 border-amber-500/50",
  };
  
  const [textColor, bgColor, borderColor] = themes[colorTheme].split(' ');
  
  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-3"
    >
      <div className="flex items-center gap-2">
        <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${textColor} ${bgColor}`}>{title}</span>
        <h3 className="text-xs font-bold uppercase tracking-wide text-slate-300">{label}</h3>
      </div>
      <div className={`text-sm text-slate-300/90 leading-relaxed bg-slate-950/40 p-3 rounded-r-md rounded-bl-md border-l-2 ${borderColor}`}>
         {items && items.length > 0 ? (
           <ul className="list-disc pl-4 space-y-1">
              {items.map((item, idx) => (
                  <li key={idx} className="whitespace-pre-wrap">{item}</li>
              ))}
           </ul>
         ) : (
           <p className="opacity-40 italic">Awaiting information...</p>
         )}
      </div>
    </motion.div>
  );
}
