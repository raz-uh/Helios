
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration } from '@google/genai';
import { ConnectionStatus, TranscriptEntry, SystemStatus } from './types';
import { decode, encode, decodeAudioData } from './services/audioUtils';

const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-12-2025';
const FRAME_RATE = 2;
const AUDIO_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;

// Tooltip dictionary for technical terms
const TOOLTIP_DATA: Record<string, string> = {
  torque: "Rotational force measurement. Critical for mechanical joint integrity. Reference: ISO 6789.",
  capacitor: "DANGER: Stores electrical charge. Can deliver lethal shocks even when powered down. Discharge required.",
  resistor: "Electronic component that limits current. Monitor for thermal damage or discoloration.",
  SKU: "Stock Keeping Unit. Unique identifier used for inventory management and automated retrieval.",
  NPU: "Neural Processing Unit. Specialized hardware designed to accelerate AI vision processing and logic.",
  latency: "Round-trip time for data packets. Optimal mission performance requires < 200ms.",
  buffer: "Temporary storage area for incoming telemetry streams to ensure smooth visual processing.",
  recognition: "Real-time object classification and edge detection using Helios Vision model.",
  safety: "Critical monitoring of high-voltage, high-pressure, or mechanical hazards in the environment."
};

// Tooltip Component
const Tooltip: React.FC<{ text: string; children: React.ReactNode }> = ({ text, children }) => {
  return (
    <span className="relative inline-block group cursor-help">
      <span className="underline decoration-blue-500/40 decoration-dotted underline-offset-4 group-hover:decoration-blue-400 group-hover:text-blue-300 transition-colors">
        {children}
      </span>
      <div className="invisible group-hover:visible absolute bottom-full left-1/2 -translate-x-1/2 mb-3 w-56 p-3 bg-blue-950/95 border border-blue-400/50 backdrop-blur-xl text-[10px] text-blue-100 rounded-sm shadow-[0_0_20px_rgba(37,99,235,0.5)] z-[100] pointer-events-none mono leading-relaxed">
        <div className="flex items-center mb-1 pb-1 border-b border-blue-400/20">
          <span className="w-1.5 h-1.5 bg-blue-400 rounded-full mr-2 animate-pulse" />
          <span className="font-bold uppercase tracking-widest text-[8px] text-blue-400">Technical Data</span>
        </div>
        {text}
        <div className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[6px] border-t-blue-400/50" />
      </div>
    </span>
  );
};

const App: React.FC = () => {
  const aiRef = useRef<any>(null);
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nextStartTimeRef = useRef<number>(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const frameIntervalRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [sysStatus, setSysStatus] = useState<SystemStatus>({
    cpu: 8,
    memory: 32,
    latency: 120,
    visionActive: false
  });
  const [isMuted, setIsMuted] = useState(false);
  const [isFlashing, setIsFlashing] = useState(false);

  // Helper to format text with tooltips
  const formatTextWithTooltips = useCallback((text: string) => {
    // Replaced JSX.Element with React.ReactNode to resolve namespace error
    let parts: (string | React.ReactNode)[] = [text];
    Object.entries(TOOLTIP_DATA).forEach(([key, value]) => {
      // Replaced JSX.Element with React.ReactNode to resolve namespace error
      const newParts: (string | React.ReactNode)[] = [];
      parts.forEach(part => {
        if (typeof part === 'string') {
          const splitParts = part.split(new RegExp(`(${key})`, 'gi'));
          splitParts.forEach((subPart, i) => {
            if (subPart.toLowerCase() === key.toLowerCase()) {
              newParts.push(<Tooltip key={`${key}-${i}`} text={value}>{subPart}</Tooltip>);
            } else if (subPart !== '') {
              newParts.push(subPart);
            }
          });
        } else {
          newParts.push(part);
        }
      });
      parts = newParts;
    });
    return parts;
  }, []);

  const tools: FunctionDeclaration[] = [
    {
      name: 'get_repair_manual',
      description: 'Retrieves specific torque specs or wiring diagrams for a given model and component.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          model_number: { type: Type.STRING, description: 'Manufacturer model number.' },
          component_name: { type: Type.STRING, description: 'Name of the sub-system or part.' }
        },
        required: ['model_number', 'component_name']
      }
    },
    {
      name: 'check_parts_inventory',
      description: 'Checks if a replacement part is in stock at local warehouse.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          part_id: { type: Type.STRING, description: 'Part SKU or identifier.' }
        },
        required: ['part_id']
      }
    }
  ];

  const stopSession = useCallback(() => {
    if (frameIntervalRef.current) window.clearInterval(frameIntervalRef.current);
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    if (audioSourcesRef.current) audioSourcesRef.current.forEach(s => s.stop());
    audioSourcesRef.current.clear();
    setStatus(ConnectionStatus.DISCONNECTED);
    setSysStatus(prev => ({ ...prev, visionActive: false }));
  }, []);

  const captureHighRes = () => {
    setIsFlashing(true);
    setTimeout(() => setIsFlashing(false), 500);
  };

  const startSession = async () => {
    if (!process.env.API_KEY) {
      alert("Missing API Key environment variable.");
      return;
    }

    try {
      setStatus(ConnectionStatus.CONNECTING);
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      aiRef.current = ai;
      inputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: AUDIO_SAMPLE_RATE });
      outputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: OUTPUT_SAMPLE_RATE });

      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: true, 
        video: { width: { ideal: 1920 }, height: { ideal: 1080 } } 
      });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;

      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } },
          },
          systemInstruction: `You are "Helios," a Master Field Engineer Agent. 
          MISSION: Real-time complex mechanical/electronic repairs using multimodal vision and low-latency reasoning.
          PHASE 1 (ID): Identify object/make/model.
          PHASE 2 (SAFETY): MANDATORY safety warning first. Mention specifically if you see capacitors or exposed wiring.
          PHASE 3 (DIAG): Guide user to move camera for better angles.
          PHASE 4 (GUIDANCE): Numbered, technical instructions. Use spatial terms and specify torque requirements.
          PHASE 5 (VERIFY): Visually verify work before next steps.
          TONE: Professional, urgent, calm, highly technical. No fluff.`,
          tools: [{ functionDeclarations: tools }],
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            setSysStatus(prev => ({ ...prev, visionActive: true }));

            const source = inputAudioCtxRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioCtxRef.current!.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              if (isMuted) return;
              const inputData = e.inputBuffer.getChannelData(0);
              const int16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) int16[i] = inputData[i] * 32768;
              const blob = {
                data: encode(new Uint8Array(int16.buffer)),
                mimeType: 'audio/pcm;rate=16000',
              };
              sessionPromise.then(s => s.sendRealtimeInput({ media: blob }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioCtxRef.current!.destination);

            frameIntervalRef.current = window.setInterval(() => {
              if (canvasRef.current && videoRef.current) {
                const ctx = canvasRef.current.getContext('2d');
                if (ctx) {
                  ctx.drawImage(videoRef.current, 0, 0, 640, 360);
                  canvasRef.current.toBlob(async (blob) => {
                    if (blob) {
                      const reader = new FileReader();
                      reader.onloadend = () => {
                        const base64 = (reader.result as string).split(',')[1];
                        sessionPromise.then(s => s.sendRealtimeInput({ media: { data: base64, mimeType: 'image/jpeg' } }));
                      };
                      reader.readAsDataURL(blob);
                    }
                  }, 'image/jpeg', 0.6);
                }
              }
            }, 1000 / FRAME_RATE);
          },
          onmessage: async (msg: LiveServerMessage) => {
            const audioData = msg.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData && outputAudioCtxRef.current) {
              const start = Date.now();
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputAudioCtxRef.current.currentTime);
              const buffer = await decodeAudioData(decode(audioData), outputAudioCtxRef.current, OUTPUT_SAMPLE_RATE, 1);
              const source = outputAudioCtxRef.current.createBufferSource();
              source.buffer = buffer;
              source.connect(outputAudioCtxRef.current.destination);
              source.onended = () => audioSourcesRef.current.delete(source);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              audioSourcesRef.current.add(source);
              setSysStatus(prev => ({ ...prev, latency: Date.now() - start }));
            }

            if (msg.serverContent?.inputTranscription) {
              setTranscript(prev => [...prev, { role: 'user', text: msg.serverContent!.inputTranscription!.text, timestamp: Date.now() }].slice(-50));
            }
            if (msg.serverContent?.outputTranscription) {
              setTranscript(prev => [...prev, { role: 'helios', text: msg.serverContent!.outputTranscription!.text, timestamp: Date.now() }].slice(-50));
            }

            if (msg.toolCall) {
              for (const fc of msg.toolCall.functionCalls) {
                let response = "Error: Invalid Call";
                if (fc.name === 'get_repair_manual') {
                  response = `RETRIEVING MANUAL [${fc.args.model_number}]: Component ${fc.args.component_name} specs: 15.5Nm torque required. Yellow/Blue striped wire is sensor signal. Safety check: ensure all capacitors are discharged.`;
                } else if (fc.name === 'check_parts_inventory') {
                  response = `INVENTORY_MGMT: SKU ${fc.args.part_id} located in Bay 4. Stock: 14 units. Replacement estimated at 45 minutes labor.`;
                }
                sessionPromise.then(s => s.sendToolResponse({
                  functionResponses: { id: fc.id, name: fc.name, response: { result: response } }
                }));
              }
            }

            if (msg.serverContent?.interrupted) {
              audioSourcesRef.current.forEach(s => s.stop());
              audioSourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e) => setStatus(ConnectionStatus.ERROR),
          onclose: () => stopSession()
        }
      });
      sessionPromiseRef.current = sessionPromise;
    } catch (err) {
      console.error(err);
      setStatus(ConnectionStatus.ERROR);
    }
  };

  return (
    <div className="flex h-screen w-full bg-[#020617] overflow-hidden select-none">
      {/* --- Sidebar (Left) --- */}
      <div className="w-80 bg-[#0f172a] border-r border-blue-500/20 flex flex-none flex-col p-5 space-y-6 z-20 shadow-2xl">
        <div className="flex items-center space-x-3 mb-2">
          <div className="w-10 h-10 bg-blue-600 rounded-sm flex items-center justify-center text-white font-black text-2xl shadow-[0_0_15px_rgba(37,99,235,0.4)]">H</div>
          <div>
            <h1 className="font-extrabold text-xl leading-tight uppercase tracking-widest text-white">HELIOS</h1>
            <p className="text-[10px] text-blue-400 mono font-bold tracking-tighter uppercase">SpaceX Field Ops Core</p>
          </div>
        </div>

        <div className="space-y-4">
          <div className="p-3 bg-black/40 border border-blue-500/10 rounded-sm">
            <h2 className="text-[10px] text-blue-400 uppercase mb-2 mono font-bold">Diagnostics Hub</h2>
            <div className="space-y-2 text-xs mono">
              <div className="flex justify-between">
                <span className="text-white/40">LINK</span>
                <span className={status === ConnectionStatus.CONNECTED ? 'text-blue-400 font-bold' : 'text-slate-500'}>
                  {status}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-white/40">REASONING</span>
                <span className="text-blue-400">ACTIVE (v2.5)</span>
              </div>
              <div className="flex justify-between">
                <span className="text-white/40 tracking-tighter">
                  <Tooltip text={TOOLTIP_DATA.latency}>SIGNAL</Tooltip>
                </span>
                <span className="text-white/60">{sysStatus.latency}ms</span>
              </div>
            </div>
          </div>

          <div className="p-3 bg-black/40 border border-blue-500/10 rounded-sm">
            <h2 className="text-[10px] text-blue-400 uppercase mb-2 mono font-bold">Telemetry</h2>
            <div className="space-y-3">
              <div>
                <div className="flex justify-between text-[10px] mb-1 mono">
                  <span><Tooltip text={TOOLTIP_DATA.NPU}>NPU LOAD</Tooltip></span>
                  <span>{sysStatus.cpu}%</span>
                </div>
                <div className="w-full h-1 bg-white/5 rounded-full overflow-hidden">
                  <div className="h-full bg-blue-500 transition-all duration-500" style={{ width: `${sysStatus.cpu}%` }} />
                </div>
              </div>
              <div>
                <div className="flex justify-between text-[10px] mb-1 mono">
                  <span><Tooltip text={TOOLTIP_DATA.buffer}>BUFFER</Tooltip></span>
                  <span>{sysStatus.memory}%</span>
                </div>
                <div className="w-full h-1 bg-white/5 rounded-full overflow-hidden">
                  <div className="h-full bg-cyan-400 transition-all duration-500" style={{ width: `${sysStatus.memory}%` }} />
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="flex-grow flex flex-col min-h-0 space-y-4">
          <h2 className="text-[10px] text-blue-400 uppercase mono font-bold flex items-center">
            <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse mr-2" />
            Mission Log
          </h2>
          <div className="flex-grow overflow-y-auto pr-2 space-y-4 scrollbar-thin scrollbar-thumb-blue-900/40 overflow-x-hidden">
            {transcript.length === 0 && <p className="text-[11px] text-white/20 italic font-mono uppercase tracking-widest">Awaiting uplink...</p>}
            {transcript.map((entry, i) => (
              <div key={i} className={`p-3 rounded-sm text-[11px] font-mono leading-relaxed border-l-2 ${entry.role === 'helios' ? 'bg-blue-600/5 border-blue-500 text-blue-100' : 'bg-white/5 border-white/20 text-white/70'}`}>
                <div className="flex justify-between mb-1 opacity-50 uppercase text-[9px] font-bold">
                  <span>{entry.role}</span>
                  <span>{new Date(entry.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                </div>
                <div className="break-words">
                  {formatTextWithTooltips(entry.text)}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="pt-4 border-t border-blue-500/20">
          <button 
            onClick={status === ConnectionStatus.DISCONNECTED ? startSession : stopSession}
            className={`w-full py-3 rounded-sm font-black uppercase text-xs tracking-[0.2em] transition-all duration-300 ${
              status === ConnectionStatus.DISCONNECTED 
                ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-[0_0_20px_rgba(37,99,235,0.3)]' 
                : 'bg-red-500/10 hover:bg-red-500/20 text-red-500 border border-red-500/30'
            }`}
          >
            {status === ConnectionStatus.DISCONNECTED ? 'INITIATE OPS' : 'TERMINATE LINK'}
          </button>
        </div>
      </div>

      {/* --- Main Feed (Right) --- */}
      <div className="flex-grow relative bg-black flex flex-col shadow-inner">
        {/* Video Layer */}
        <div className="absolute inset-0 z-0 overflow-hidden">
          <video 
            ref={videoRef} 
            autoPlay 
            muted 
            playsInline 
            className="w-full h-full object-cover grayscale brightness-75 contrast-125"
          />
          <div className="crt-overlay absolute inset-0" />
          <div className="scanner-line" />
          
          {/* AR Brackets */}
          <div className="ar-bracket ar-bracket-tl" />
          <div className="ar-bracket ar-bracket-tr" />
          <div className="ar-bracket ar-bracket-bl" />
          <div className="ar-bracket ar-bracket-br" />

          {/* Flash Effect */}
          {isFlashing && <div className="absolute inset-0 z-50 flash pointer-events-none" />}
        </div>

        {/* UI Overlay Layer */}
        <div className="relative h-full w-full z-10 p-10 flex flex-col pointer-events-none">
          <div className="flex justify-between items-start">
            <div className="flex space-x-6">
              <div className="flex flex-col">
                <span className="text-[9px] mono text-blue-400 font-bold uppercase tracking-widest">Sensor_Node</span>
                <span className="text-xs mono text-white/80">FRONT_OPTIC_01</span>
              </div>
              <div className="flex flex-col">
                <span className="text-[9px] mono text-blue-400 font-bold uppercase tracking-widest">Stream_Resolution</span>
                <span className="text-xs mono text-white/80">1920x1080px</span>
              </div>
            </div>
            <div className="flex items-center space-x-3 bg-black/60 px-4 py-2 rounded-sm border border-blue-500/20">
              <div className="w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse" />
              <div className="text-[10px] mono font-black uppercase tracking-widest text-blue-100">AI AGENT LINK: NOMINAL</div>
            </div>
          </div>

          <div className="flex-grow flex items-center justify-center">
             <div className="relative w-64 h-64 border border-blue-500/20 rounded-full flex items-center justify-center">
                <div className="absolute w-[120%] h-[1px] bg-blue-500/10" />
                <div className="absolute h-[120%] w-[1px] bg-blue-500/10" />
                <div className="w-12 h-12 border border-blue-400/50 rounded-sm relative">
                   <div className="absolute -top-1 -left-1 w-2 h-2 bg-blue-400" />
                </div>
                <div className="absolute inset-0 border-[4px] border-blue-500/5 rounded-full animate-[spin_10s_linear_infinite]" />
             </div>
          </div>

          <div className="flex flex-col items-center space-y-6">
             <div className="flex items-center pointer-events-auto space-x-4">
                <button 
                  onClick={captureHighRes}
                  className="px-6 py-3 bg-blue-600/10 border border-blue-500 text-blue-400 text-[10px] font-black uppercase tracking-widest rounded-sm hover:bg-blue-600 hover:text-white transition-all shadow-[0_0_15px_rgba(37,99,235,0.2)]"
                >
                  Capture High-Res
                </button>

                <button 
                    onClick={() => setIsMuted(!isMuted)}
                    className={`p-4 rounded-full transition-all border ${isMuted ? 'bg-red-500/20 border-red-500 text-red-500' : 'bg-blue-500/20 border-blue-500 text-blue-400 hover:bg-blue-500/30'}`}
                >
                    {isMuted ? (
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
                      </svg>
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                      </svg>
                    )}
                </button>

                <div className="flex items-end space-x-1 h-8">
                   {[...Array(8)].map((_, i) => (
                     <div 
                       key={i} 
                       className={`wave-bar w-1 bg-blue-500/60 rounded-full`} 
                       style={{ animationDelay: `${i * 0.1}s`, opacity: status === ConnectionStatus.CONNECTED ? 1 : 0.2 }} 
                     />
                   ))}
                </div>
             </div>

             <div className="px-10 py-4 bg-black/90 border border-blue-500/20 rounded-sm flex items-center space-x-12 backdrop-blur-md">
               <div className="flex flex-col items-center">
                 <span className="text-[8px] text-blue-400/60 uppercase mono font-black">
                   <Tooltip text={TOOLTIP_DATA.recognition}>Visual_Proc</Tooltip>
                 </span>
                 <span className="text-xs font-black text-blue-100 mono tracking-widest">ENABLED</span>
               </div>
               <div className="w-[1px] h-8 bg-blue-500/20" />
               <div className="flex flex-col items-center">
                 <span className="text-[8px] text-blue-400/60 uppercase mono font-black">Logic_Layer</span>
                 <span className="text-xs font-black text-blue-100 mono tracking-widest uppercase">Real_Time</span>
               </div>
               <div className="w-[1px] h-8 bg-blue-500/20" />
               <div className="flex flex-col items-center">
                 <span className="text-[8px] text-blue-400/60 uppercase mono font-black">
                   <Tooltip text={TOOLTIP_DATA.safety}>Safety_Status</Tooltip>
                 </span>
                 <span className="text-xs font-black text-green-400 mono tracking-widest uppercase tracking-tighter">Monitored</span>
               </div>
             </div>
          </div>
        </div>
        <canvas ref={canvasRef} width={640} height={360} className="hidden" />
      </div>

      {/* Ambient Text Accents */}
      <div className="absolute bottom-4 right-4 z-30 pointer-events-none text-right mono">
        <div className="text-[10px] text-blue-500/40">GEO_TAG: 37.7749° N, 122.4194° W</div>
        <div className="text-[10px] text-white/10 uppercase tracking-widest">Proprietary Core Algorithm // Helios v3.5.2</div>
      </div>
    </div>
  );
};

export default App;
