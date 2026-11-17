import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Share as ShareIcon,
  Download as DownloadIcon,
  Close as CloseIcon,
  ContentCopy as CopyIcon,
  CheckCircle as CheckIcon,
  CloudUpload as UploadIcon,
  CloudDownload as CloudDownloadIcon,
  Wifi as WifiIcon,
  WifiOff as WifiOffIcon,
  Security as SecurityIcon,
  Info as InfoIcon,
  Error as ErrorIcon,
  Cancel as CancelIcon,
  Search as SearchIcon
} from '@mui/icons-material';
import Checkbox from './ui/Checkbox';
import FolderTree from './FolderTree';
import TailInput from './ui/TailInput';
import './SharingPanel.css';

import { useAlert } from './AlertHandler';
import { useDialog } from '../hooks/useDialog'

type InstalledMod = {
  path: string;
  custom_name?: string;
};

type ShareInfo = {
  peer_id: string;
  addresses: string[];
  encryption_key: string;
  share_code: string;
};

type PackPreview = {
  total_size: number;
  file_count: number;
};

type TransferStatus = 'Connecting' | 'Handshaking' | 'Transferring' | 'Verifying' | 'Completed' | 'Cancelled' | { Failed: string };

type TransferProgress = {
  current_file: string;
  mods_completed: number;
  total_mods: number;
  files_completed: number;
  total_files: number;
  bytes_transferred: number;
  total_bytes: number;
  status: TransferStatus;
};

type UploadProgress = {
  active: boolean;
  peer_name: string | null;
  current_file: string;
  mods_completed: number;
  total_mods: number;
  files_completed: number;
  total_files: number;
  bytes_transferred: number;
  total_bytes: number;
  completed_transfers: number;
};

type SpeedSample = { bytes: number; time: number };

type FolderRecord = {
  id: string;
  name: string;
  is_root?: boolean;
};

type SharingPanelProps = {
  onClose: () => void;
  gamePath?: string;
  installedMods: InstalledMod[];
  selectedMods?: Set<string>;
  folders?: FolderRecord[];
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

const formatDuration = (seconds: number): string => {
  const s = Math.ceil(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

export default function SharingPanel({ onClose, gamePath, installedMods, selectedMods, folders = [] }: SharingPanelProps) {
  const dialog = useDialog(onClose, 'Mod sharing')
  const alert = useAlert();
  const [activeTab, setActiveTab] = useState('share'); // 'share' or 'receive'
  // const [error, setError] = useState(''); // Removed local error state in favor of toasts

  // Share State
  const [packName, setPackName] = useState('');
  const [packDesc, setPackDesc] = useState('');
  const [creatorName, setCreatorName] = useState('User');
  const [shareInfo, setShareInfo] = useState<ShareInfo | null>(null);
  const [isSharing, setIsSharing] = useState(false);
  const [selectedModPaths, setSelectedModPaths] = useState<Set<string>>(new Set());
  const [packPreview, setPackPreview] = useState<PackPreview | null>(null);
  const [calculatingPreview, setCalculatingPreview] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  // Receive State
  const [connectionString, setConnectionString] = useState('');
  const [clientName, setClientName] = useState('User');
  const [isReceiving, setIsReceiving] = useState(false);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [receiveComplete, setReceiveComplete] = useState(false);
  const receiveHandledRef = useRef(false);
  const [transferSpeed, setTransferSpeed] = useState(0); // bytes per second
  const speedSampleRef = useRef<SpeedSample[]>([]);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [uploadSpeed, setUploadSpeed] = useState(0); // bytes per second
  const uploadSampleRef = useRef<SpeedSample[]>([]);
  const [isValidCode, setIsValidCode] = useState<boolean | null>(null); // null, true, false
  const rootFolder = folders.find(f => f.is_root);
  const [receiveFolderId, setReceiveFolderId] = useState<string | null>(rootFolder?.id ?? null);

  // Initialize selected mods from props
  useEffect(() => {
    if (selectedMods && selectedMods.size > 0) {
      setSelectedModPaths(new Set(selectedMods));
      setPackName(`My Mod Pack (${selectedMods.size} mods)`);
      setPackPreview(null); // Reset preview
    }
  }, [selectedMods]);

  // Poll for status
  useEffect(() => {
    let interval;
    checkStatus();
    interval = setInterval(checkStatus, 500);
    return () => clearInterval(interval);
  }, []);

  // Validation helper
  const validateConnectionString = (str: string): boolean => {
    try {
      const decoded = atob(str);
      const shareInfo = JSON.parse(decoded);
      return !!(shareInfo.peer_id && shareInfo.share_code && shareInfo.encryption_key);
    } catch (e) {
      return false;
    }
  };

  // Validation effect
  useEffect(() => {
    const validate = async () => {
      if (!connectionString.trim()) {
        setIsValidCode(null);
        return;
      }

      // Client-side validation (Base64 ShareInfo)
      if (!validateConnectionString(connectionString)) {
        setIsValidCode(false);
        return;
      }

      try {
        const valid = await invoke<boolean>('p2p_validate_connection_string', { connectionString });
        setIsValidCode(valid);
      } catch (e) {
        setIsValidCode(false);
      }
    };
    const timeout = setTimeout(validate, 500);
    return () => clearTimeout(timeout);
  }, [connectionString]);

  // Data arrives in 1 MB chunks, so on a slow link the byte counter sits still
  // for seconds and then jumps. Measuring bytes per poll (or per fixed window)
  // turns that into pulses, so time the jumps instead: a sample is recorded only
  // when the counter moves, and speed is bytes between the oldest and newest
  // jump over the time between them.
  const SPEED_WINDOW_MS = 10000;
  const updateSpeed = (
    bytes: number,
    samplesRef: React.MutableRefObject<SpeedSample[]>,
    setSpeed: React.Dispatch<React.SetStateAction<number>>,
  ) => {
    const now = performance.now();
    const samples = samplesRef.current;
    const last = samples[samples.length - 1];

    if (!last || bytes < last.bytes) {
      // First poll, or a new attempt/transfer started
      samplesRef.current = [{ bytes, time: now }];
      setSpeed(0);
      return;
    }
    if (bytes > last.bytes) {
      samples.push({ bytes, time: now });
      while (samples.length > 3 && now - samples[1].time >= SPEED_WINDOW_MS) samples.shift();
    } else if (samples.length === 1) {
      // Nothing has moved yet: keep the baseline at "now" so time spent
      // waiting or connecting isn't counted against the first chunk
      last.time = now;
    }
    if (samples.length < 2) return;

    const first = samples[0];
    const newest = samples[samples.length - 1];
    const transferred = newest.bytes - first.bytes;
    const span = newest.time - first.time;
    const idle = now - newest.time;
    const expectedGap = span / (samples.length - 1);
    // If the next jump is overdue the link has slowed or stalled: let the
    // readout decay instead of holding the old rate
    const elapsed = idle > expectedGap * 2 + 1000 ? now - first.time : span;
    setSpeed(transferred / (elapsed / 1000));
  };

  const checkStatus = async () => {
    try {
      const sharing = await invoke('p2p_is_sharing') as any;
      setIsSharing(sharing);

      if (sharing) {
        const session = await invoke<ShareInfo | null>('p2p_get_share_session');
        if (session) setShareInfo(session);
        const upload = await invoke<UploadProgress | null>('p2p_get_share_progress');
        setUploadProgress(upload);
        if (upload) updateSpeed(upload.bytes_transferred, uploadSampleRef, setUploadSpeed);
      } else {
        setUploadProgress(null);
      }

      const receiving = await invoke('p2p_is_receiving') as any;

      if (receiving && !receiveHandledRef.current) {
        setIsReceiving(true);
        const prog = await invoke<TransferProgress | null>('p2p_get_receive_progress');
        if (prog) {
          setProgress(prog);
          updateSpeed(prog.bytes_transferred, speedSampleRef, setTransferSpeed);
          const isTerminal = prog.status === 'Completed'
            || prog.status === 'Cancelled'
            || (typeof prog.status === 'object' && prog.status !== null && 'Failed' in prog.status);

          if (isTerminal) {
            // Guard immediately before any async work to prevent duplicate handling
            if (receiveHandledRef.current) return;
            receiveHandledRef.current = true;

            setIsReceiving(false);
            await invoke('p2p_stop_receiving');

            if (prog.status === 'Completed') {
              setReceiveComplete(true);
              const count = prog.total_mods || prog.mods_completed;
              alert.success('Receive Complete', count > 0
                ? `${count} mod${count !== 1 ? 's' : ''} received and installed.`
                : 'All mods received and installed.');
            } else if (typeof prog.status === 'object' && 'Failed' in prog.status) {
              alert.error('Transfer Failed', (prog.status as { Failed: string }).Failed);
            }
          }
        }
      }
    } catch (err) {
      console.error("Status check failed:", err);
    }
  };

  // Helper to get the connection string from ShareInfo
  const getConnectionString = () => {
    if (!shareInfo) return '';
    try {
      return btoa(JSON.stringify(shareInfo));
    } catch (e) {
      console.error("Failed to encode ShareInfo", e);
      return '';
    }
  };

  // Auto-calculate pack preview when selected mods change
  useEffect(() => {
    if (selectedModPaths.size === 0) {
      setPackPreview(null);
      setCalculatingPreview(false);
      return;
    }
    setCalculatingPreview(true);
    const timeout = setTimeout(async () => {
      try {
        const preview = await invoke<PackPreview>('p2p_create_mod_pack_preview', {
          name: packName || "Untitled",
          description: packDesc || "",
          modPaths: Array.from(selectedModPaths),
          creator: creatorName
        });
        setPackPreview(preview);
      } catch (err) {
        console.error("Preview failed", err);
      } finally {
        setCalculatingPreview(false);
      }
    }, 300);
    return () => clearTimeout(timeout);
  }, [selectedModPaths]);

  const handleStartSharing = async () => {
    if (selectedModPaths.size === 0) {
      alert.error("Select Mods", "Please select at least one mod to share.");
      return;
    }
    if (!packName.trim()) {
      alert.error("Missing Name", "Please enter a pack name.");
      return;
    }

    const toastId = alert.showAlert({
      title: 'Starting Session',
      description: 'Initializing P2P network...',
      color: 'default',
      isLoading: true,
      duration: 0 // Persistent while loading
    });

    try {
      const session = await invoke<ShareInfo>('p2p_start_sharing', {
        name: packName,
        description: packDesc,
        modPaths: Array.from(selectedModPaths),
        creator: creatorName
      });
      setShareInfo(session);
      setIsSharing(true);


      // Update toast to Info (Primary) state instead of Success
      alert.updateToast(toastId, {
        title: 'Sharing Active',
        description: 'Your mod pack is now online.',
        color: 'primary',
        isLoading: false,
        duration: 5000
      });
    } catch (err) {
      alert.updateToast(toastId, {
        title: 'Share Failed',
        description: String(err),
        color: 'danger',
        isLoading: false,
        duration: 5000
      });
    }
  };

  const handleStopSharing = async () => {
    try {
      const code = shareInfo?.share_code || '';
      await invoke('p2p_stop_sharing', { shareCode: code });

      setShareInfo(null);
      setIsSharing(false);

      alert.info('Sharing Stopped', 'The sharing session has been terminated.');
    } catch (err) {
      alert.error('Stop Failed', `Failed to stop sharing: ${err}`);
    }
  };

  const handleStartReceiving = async () => {
    if (!connectionString.trim()) {
      alert.error("Missing Code", "Please enter a connection string.");
      return;
    }

    if (!validateConnectionString(connectionString)) {
      alert.error("Invalid Code", "The connection string format is incorrect.");
      return;
    }

    alert.promise(
      async () => {
        // Validate first
        await invoke('p2p_validate_connection_string', { connectionString });

        // Start receiving
        await invoke('p2p_start_receiving', {
          connectionString,
          clientName: clientName,
          folderId: receiveFolderId
        });

        console.debug('[SharingPanel] Starting receive', {
          clientName,
          folderId: receiveFolderId,
          hasConnectionString: Boolean(connectionString)
        });

        setIsReceiving(true);
        setReceiveComplete(false);

      },
      {
        loading: { title: 'Connecting', description: 'Establishing connection to host...' },
        success: { title: 'Connected', description: 'Receiving starting...' },
        error: (err) => ({ title: 'Connection Failed', description: String(err) })
      }
    );
  };

  const handleStopReceiving = async () => {
    try {
      await invoke('p2p_stop_receiving');
      setIsReceiving(false);

      alert.info('Receive Cancelled', 'The receive was cancelled by user.');
    } catch (err) {
      alert.error('Cancel Failed', `Failed to stop receive: ${err}`);
    }
  };

  const [copied, setCopied] = useState(false);
  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const toggleModSelection = (path: string) => {
    const newSet = new Set(selectedModPaths);
    if (newSet.has(path)) {
      newSet.delete(path);
    } else {
      newSet.add(path);
    }
    setSelectedModPaths(newSet);
    setPackPreview(null); // Invalidate preview
  };

  const receiveFraction = progress && progress.total_bytes > 0
    ? Math.min(progress.bytes_transferred / progress.total_bytes, 1)
    : 0;
  const uploadFraction = uploadProgress && uploadProgress.total_bytes > 0
    ? Math.min(uploadProgress.bytes_transferred / uploadProgress.total_bytes, 1)
    : 0;

  return (
    <div className="p2p-overlay">
      <motion.div
        {...dialog}
                className="p2p-modal"
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.15 }}
      >
        <div className="p2p-header">
          <div className="p2p-title">
            <WifiIcon className="p2p-icon" />
            <h2>Mod Sharing</h2>
          </div>
          <button onClick={onClose} className="btn-icon-close" aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        <div className="p2p-tabs">
          <button
            className={`p2p-tab ${activeTab === 'share' ? 'active' : ''}`}
            onClick={() => setActiveTab('share')}
          >
            <UploadIcon fontSize="small" /> Share Mods
          </button>
          <button
            className={`p2p-tab ${activeTab === 'receive' ? 'active' : ''}`}
            onClick={() => setActiveTab('receive')}
          >
            <CloudDownloadIcon fontSize="small" /> Receive Mods
          </button>
        </div>

        <div className="p2p-content">


          {activeTab === 'share' && (
            <div className="share-view">
              {!isSharing ? (
                <>
                  <div className="share-layout-grid">
                    <div className="share-left-col">
                      <div className="mod-selection-list">
                        <div className="mod-list-header">
                          <label>Select Mods to Share ({selectedModPaths.size})</label>
                          <div className="search-box">
                            <SearchIcon fontSize="small" className="search-icon" />
                            <input
                              type="text"
                              value={searchTerm}
                              onChange={(e) => setSearchTerm(e.target.value)}
                              placeholder="Search mods..."
                            />
                          </div>
                        </div>
                        <div className="mod-list-scroll">
                          {installedMods.filter((mod) => {
                            const filename = mod.path.split(/[/\\]/).pop();
                            const name = mod.custom_name || (filename || '').replace(/_\d+_P/g, '').replace(/\.pak$/i, '').replace(/\.bak_repak$/i, '');
                            return name.toLowerCase().includes(searchTerm.toLowerCase());
                          }).map((mod) => {
                            const filename = mod.path.split(/[/\\]/).pop();
                            const displayName = mod.custom_name || (filename || '').replace(/_\d+_P/g, '').replace(/\.pak$/i, '').replace(/\.bak_repak$/i, '');
                            return (
                              <div
                                key={mod.path}
                                className={`mod-select-item ${selectedModPaths.has(mod.path) ? 'selected' : ''}`}
                                onClick={() => toggleModSelection(mod.path)}
                              >
                                <Checkbox
                                  checked={selectedModPaths.has(mod.path)}
                                  size="sm"
                                />
                                <span className="mod-name">
                                  {displayName}
                                </span>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    </div>

                    <div className="share-right-col">
                      <div className="form-group">
                        <label>Pack Name</label>
                        <input
                          type="text"
                          value={packName}
                          onChange={(e) => setPackName(e.target.value)}
                          placeholder="e.g. My Repak X modpack"
                          className="p2p-input"
                        />
                      </div>
                      <div className="form-group">
                        <label>Description (Optional)</label>
                        <textarea
                          value={packDesc}
                          onChange={(e) => setPackDesc(e.target.value)}
                          placeholder="Describe what's in this pack..."
                          className="p2p-textarea"
                        />
                      </div>
                      <div className="form-group">
                        <label>Creator Name (Optional)</label>
                        <input
                          type="text"
                          value={creatorName}
                          onChange={(e) => setCreatorName(e.target.value)}
                          placeholder="Your Name"
                          className="p2p-input"
                        />
                      </div>

                      {selectedModPaths.size > 0 && (
                        <div className={`pack-preview-section ${calculatingPreview ? 'calculating' : ''}`}>
                          <div className="preview-info">
                            <span>Total Size: {packPreview ? `${(packPreview.total_size / 1024 / 1024).toFixed(2)} MB` : '—'}</span>
                            <span>Mods: {selectedModPaths.size}</span>
                            <span>Files: {packPreview ? packPreview.file_count : '—'}</span>
                          </div>
                        </div>
                      )}

                      <button onClick={handleStartSharing} className="btn-primary btn-large">
                        <ShareIcon /> Start Sharing
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="active-share-view">
                  <div className="success-banner">
                    <CheckIcon /> Sharing Active
                  </div>

                  <div className="share-code-display">
                    <label>SHARE CODE</label>
                    <div className="code-box">
                      {getConnectionString()}
                      <button
                        onClick={() => copyToClipboard(getConnectionString())}
                        className={`btn-copy ${copied ? 'copied' : ''}`}
                        title="Copy to clipboard"
                      >
                        {copied ? <CheckIcon /> : <CopyIcon />}
                      </button>
                    </div>
                    <p className="hint">Share this code with your friend to let them download your pack.</p>
                  </div>

                  <div className="session-info">
                    <div className="info-row">
                      <span>Pack Name:</span>
                      <strong>{packName}</strong>
                    </div>
                    <div className="info-row">
                      <span>Creator:</span>
                      <strong>{creatorName}</strong>
                    </div>
                    <div className="info-row">
                      <span>Mods:</span>
                      <strong>{selectedModPaths.size} files</strong>
                    </div>
                    <div className="info-row">
                      <span>Security:</span>
                      <span className="secure-badge"><SecurityIcon fontSize="inherit" /> AES-256 Encrypted</span>
                    </div>
                  </div>

                  {uploadProgress && (
                    <div className="progress-container">
                      <div className="progress-info">
                        <span>{uploadProgress.active
                          ? `Sending to ${uploadProgress.peer_name || 'peer'}${uploadProgress.current_file ? ` — ${uploadProgress.current_file}` : '...'}`
                          : uploadProgress.completed_transfers > 0
                            ? `Sent to ${uploadProgress.completed_transfers} peer${uploadProgress.completed_transfers !== 1 ? 's' : ''} — waiting for more`
                            : 'Waiting for a peer to connect...'}</span>
                        <span>{uploadProgress.active ? `${Math.round(uploadFraction * 100)}%` : ''}</span>
                      </div>
                      {uploadProgress.active && (
                        <>
                          <div className="progress-bar-track">
                            <div
                              className="progress-bar-fill"
                              style={{ width: `${uploadFraction * 100}%` }}
                            />
                          </div>
                          <div className="progress-stats">
                            <span>{uploadProgress.mods_completed} / {uploadProgress.total_mods} mods · {uploadProgress.files_completed} / {uploadProgress.total_files} files</span>
                            <span>{formatBytes(uploadProgress.bytes_transferred)} / {formatBytes(uploadProgress.total_bytes)}</span>
                          </div>
                          <div className="progress-stats">
                            <span>{uploadSpeed > 0 ? `${formatBytes(uploadSpeed)}/s` : 'Measuring speed...'}</span>
                            <span>{uploadSpeed > 0 && uploadProgress.total_bytes > uploadProgress.bytes_transferred
                              ? `${formatDuration((uploadProgress.total_bytes - uploadProgress.bytes_transferred) / uploadSpeed)} left`
                              : ''}</span>
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  <button onClick={handleStopSharing} className="btn-danger btn-large">
                    <WifiOffIcon /> Stop Sharing
                  </button>
                </div>
              )}
            </div>
          )}

          {activeTab === 'receive' && (
            <div className="receive-view">
              {!isReceiving && !receiveComplete ? (
                <>
                  <div className="form-group">
                    <label>Enter Share Code</label>
                    <div className="input-with-validation">
                      <input
                        type="text"
                        value={connectionString}
                        onChange={(e) => setConnectionString(e.target.value)}
                        placeholder="Paste the connection string here..."
                        className={`p2p-input code-input ${isValidCode === true ? 'valid' : isValidCode === false ? 'invalid' : ''}`}
                      />
                      {isValidCode === true && <CheckIcon className="validation-icon valid" />}
                      {isValidCode === false && <CancelIcon className="validation-icon invalid" />}
                    </div>
                  </div>

                  <div className="form-group">
                    <label>Your Name (Optional)</label>
                    <input
                      type="text"
                      value={clientName}
                      onChange={(e) => setClientName(e.target.value)}
                      placeholder="Enter your name"
                      className="p2p-input"
                    />
                  </div>

                  <div className="form-group">
                    <label>Save To</label>
                    <div className="receive-folder-picker">
                      {folders.length > 0 && (
                        <div className="receive-folder-tree" role="tree" aria-label="Destination folders">
                          <FolderTree
                            folders={folders}
                            selectedFolderId={receiveFolderId || ''}
                            onSelect={(id) => {
                              console.debug('[SharingPanel] Selected receive folder', { folderId: id });
                              setReceiveFolderId(id);
                            }}
                            onDelete={() => {}}
                            getCount={() => 0}
                            hasFilters={false}
                            hideAllMods
                          />
                        </div>
                      )}

                      {folders.length === 0 && (
                        <TailInput
                          value={gamePath || ''}
                          placeholder="Game mods folder (default)"
                          className="p2p-input"
                          style={{ opacity: 0.6 }}
                        />
                      )}
                    </div>
                    <p style={{ fontSize: 'var(--fs-sm)', opacity: 0.5, marginTop: '0.25rem' }}>
                      {receiveFolderId ? `Selected destination: ${receiveFolderId}` : 'Defaults to your game mods folder'}
                    </p>
                  </div>

                  <div className="security-note">
                    <SecurityIcon fontSize="small" />
                    <p>Only connect to people you trust. All transfers are encrypted.</p>
                  </div>

                  <button
                    onClick={handleStartReceiving}
                    className="btn-primary btn-large"
                    disabled={isValidCode !== true}
                  >
                    <DownloadIcon /> Connect & Receive
                  </button>
                </>
              ) : (
                <div className="transfer-progress-view">
                  {receiveComplete ? (
                    <div className="completion-state">
                      <CheckIcon className="success-icon-large" />
                      <h3>Received Complete!</h3>
                      <p>All mods have been received and installed successfully.</p>
                      <button
                        onClick={() => {
                          setReceiveComplete(false);
                          receiveHandledRef.current = false;
                          setConnectionString('');
                          setProgress(null);
                          setIsValidCode(null);
                        }}
                        className="btn-secondary"
                      >
                        Receive Another
                      </button>
                    </div>
                  ) : (
                    <>
                      <h3>
                        {progress?.status === 'Connecting' && 'Connecting...'}
                        {progress?.status === 'Handshaking' && 'Handshaking...'}
                        {progress?.status === 'Transferring' && 'Receiving...'}
                        {progress?.status === 'Verifying' && 'Verifying...'}
                        {(!progress || (typeof progress.status === 'object')) && 'Receiving...'}
                      </h3>
                      {progress && (
                        <div className="progress-container">
                          <div className="progress-info">
                            <span>{progress.status === 'Transferring' || progress.status === 'Verifying'
                              ? (progress.current_file.split(/[/\\]/).pop() || progress.current_file)
                              : ''}</span>
                            <span>{progress.total_bytes > 0 ? `${Math.round(receiveFraction * 100)}%` : '—'}</span>
                          </div>
                          <div className="progress-bar-track">
                            <div
                              className="progress-bar-fill"
                              style={{ width: `${receiveFraction * 100}%` }}
                            />
                          </div>
                          <div className="progress-stats">
                            <span>{progress.total_bytes > 0 ? `${progress.mods_completed} / ${progress.total_mods} mods · ${progress.files_completed} / ${progress.total_files} files` : 'Waiting for file list...'}</span>
                            <span>{progress.total_bytes > 0
                              ? `${formatBytes(progress.bytes_transferred)} / ${formatBytes(progress.total_bytes)}`
                              : `${formatBytes(progress.bytes_transferred)} transferred`}</span>
                          </div>
                          {progress.status === 'Transferring' && (
                            <div className="progress-stats">
                              <span>{transferSpeed > 0 ? `${formatBytes(transferSpeed)}/s` : 'Measuring speed...'}</span>
                              <span>{transferSpeed > 0 && progress.total_bytes > progress.bytes_transferred
                                ? `${formatDuration((progress.total_bytes - progress.bytes_transferred) / transferSpeed)} left`
                                : ''}</span>
                            </div>
                          )}
                          <div className="status-badge">
                            {typeof progress.status === 'string' ? progress.status : (progress.status as { Failed: string }).Failed}
                          </div>
                        </div>
                      )}
                      <button onClick={handleStopReceiving} className="btn-danger">
                        Cancel Receive
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
};


