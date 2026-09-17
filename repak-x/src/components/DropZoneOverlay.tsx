import React, { useState, useMemo, useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { motion, AnimatePresence } from 'framer-motion';
import { VscFolder, VscFolderOpened, VscChevronRight, VscChevronDown, VscNewFolder } from 'react-icons/vsc';
import { MdInstallDesktop, MdCreateNewFolder } from 'react-icons/md';
import './DropZoneOverlay.css';

type FolderRecord = {
    id: string;
    name: string;
    is_root?: boolean;
};

type TreeNode = {
    id?: string;
    name: string;
    children: TreeNode[];
    isVirtual: boolean;
    fullPath?: string;
    originalName?: string;
};

type DropZoneOverlayProps = {
    isVisible: boolean;
    folders?: FolderRecord[];
    isAprilFools?: boolean;
    onInstallDrop?: () => void;
    onQuickOrganizeDrop?: (folderId: string | null) => void;
    onClose: () => void;
    onCreateFolder?: (name: string) => Promise<string | null>;
    onNewFolderDrop?: () => void;
};

// Simplified folder tree for the overlay
const buildTree = (folders: FolderRecord[]) => {
    const root: any = { id: 'root', name: 'root', children: {}, isVirtual: true };
    const sortedFolders = [...folders].sort((a, b) => a.name.localeCompare(b.name));

    sortedFolders.forEach(folder => {
        const parts = folder.id.split(/[/\\]/);
        let current = root;

        parts.forEach((part, index) => {
            if (!current.children[part]) {
                current.children[part] = {
                    name: part,
                    children: {},
                    isVirtual: true,
                    fullPath: parts.slice(0, index + 1).join('/')
                };
            }
            current = current.children[part];

            if (index === parts.length - 1) {
                current.id = folder.id;
                current.isVirtual = false;
                current.originalName = folder.name;
            }
        });
    });

    return root;
};

const convertToArray = (node: any): TreeNode[] => {
    if (!node.children) return [];
    const children = Object.values(node.children).map((child: any) => ({
        ...child,
        children: convertToArray(child)
    }));
    children.sort((a, b) => a.name.localeCompare(b.name));
    return children;
};

// Folder node with data attribute for position detection
const DropFolderNode = ({ node, selectedFolderId, onSelect, depth = 0 }: { node: TreeNode; selectedFolderId: string | null; onSelect: (folderId: string | null) => void; depth?: number }) => {
    const [isOpen, setIsOpen] = useState(true);
    const hasChildren = node.children && node.children.length > 0;
    const isSelected = selectedFolderId === node.id;

    const handleClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!node.isVirtual) {
            onSelect(node.id ?? null);
        } else {
            setIsOpen(!isOpen);
        }
    };

    return (
        <div className="drop-folder-node">
            <div
                className={`drop-folder-item ${isSelected ? 'selected' : ''} ${node.isVirtual ? 'virtual' : ''}`}
                data-folder-id={node.isVirtual ? undefined : node.id}
                data-dropzone="folder"
                onClick={handleClick}
                style={{ paddingLeft: `${depth * 16 + 8}px` }}
            >
                <span className="folder-toggle" onClick={(e) => { e.stopPropagation(); setIsOpen(!isOpen); }}>
                    {hasChildren ? (isOpen ? <VscChevronDown /> : <VscChevronRight />) : <span style={{ width: 16 }} />}
                </span>
                <span className="folder-icon">
                    {isSelected || isOpen ? <VscFolderOpened /> : <VscFolder />}
                </span>
                <span className="folder-name">{node.name}</span>
            </div>

            {hasChildren && isOpen && (
                <div className="drop-folder-children">
                    {node.children.map(child => (
                        <DropFolderNode
                            key={child.fullPath || child.id}
                            node={child}
                            selectedFolderId={selectedFolderId}
                            onSelect={onSelect}
                            depth={depth + 1}
                        />
                    ))}
                </div>
            )}
        </div>
    );
};

const DropZoneOverlay = ({
    isVisible,
    folders = [],
    isAprilFools = false,
    onInstallDrop,
    onQuickOrganizeDrop,
    onClose,
    onCreateFolder,
    onNewFolderDrop
}: DropZoneOverlayProps) => {
    const [hoveredZone, setHoveredZone] = useState<'install' | 'organize' | 'new-folder' | null>(null); // 'install' | 'organize' | 'new-folder'
    const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
    const [isCreatingFolder, setIsCreatingFolder] = useState(false);
    const overlayRef = useRef<HTMLDivElement | null>(null);
    const folderTreeRef = useRef<HTMLDivElement | null>(null);
    const scrollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // April Fools: independent dodging per card
    const [installDodge, setInstallDodge] = useState({ x: 0, y: 0, rotate: 0 });
    const [organizeDodge, setOrganizeDodge] = useState({ x: 0, y: 0, rotate: 0 });
    const [dodgeCount, setDodgeCount] = useState(0);
    const installCardRef = useRef<HTMLDivElement | null>(null);
    const organizeCardRef = useRef<HTMLDivElement | null>(null);
    const maxDodges = 6;

    // Refs for mutable state — drag-over fires at 60fps
    const dodgeCountRef = useRef(0);
    const installDodgeRef = useRef({ x: 0, y: 0, rotate: 0 });
    const organizeDodgeRef = useRef({ x: 0, y: 0, rotate: 0 });
    const cooldownRef = useRef<{ install: boolean; organize: boolean }>({ install: false, organize: false });
    const hoverDodgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastCursorRef = useRef<{ x: number; y: number } | null>(null);

    const doDodge = (
        cardRef: React.RefObject<HTMLDivElement | null>,
        offsetRef: React.MutableRefObject<{ x: number; y: number; rotate: number }>,
        setOffset: React.Dispatch<React.SetStateAction<{ x: number; y: number; rotate: number }>>,
        cooldownKey: 'install' | 'organize',
        cursorX: number,
        cursorY: number,
    ) => {
        if (dodgeCountRef.current >= maxDodges || cooldownRef.current[cooldownKey]) return false;
        if (!cardRef.current) return false;

        const rect = cardRef.current.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        cooldownRef.current[cooldownKey] = true;

        // Flee away from cursor with random spread
        const dx = cursorX - centerX;
        const dy = cursorY - centerY;
        const baseAngle = Math.atan2(dy, dx);
        // Add random spread so directions feel chaotic (±45°)
        const spread = (Math.random() - 0.5) * Math.PI * 0.5;
        const angle = baseAngle + spread;
        const fleeDist = 250 + Math.random() * 200;

        const moveX = -Math.cos(angle) * fleeDist;
        const moveY = -Math.sin(angle) * fleeDist;

        const maxX = window.innerWidth * 0.35;
        const maxY = window.innerHeight * 0.3;
        const prev = offsetRef.current;
        // Random rotation kick: ±8-20° per dodge, alternating feel
        const rotateKick = (Math.random() > 0.5 ? 1 : -1) * (8 + Math.random() * 12);
        const newOffset = {
            x: Math.max(-maxX, Math.min(maxX, prev.x + moveX)),
            y: Math.max(-maxY, Math.min(maxY, prev.y + moveY)),
            rotate: prev.rotate + rotateKick,
        };

        offsetRef.current = newOffset;
        dodgeCountRef.current += 1;
        setOffset(newOffset);
        setDodgeCount(dodgeCountRef.current);

        // Clear hover
        setHoveredZone(null);
        setSelectedFolderId(null);

        setTimeout(() => { cooldownRef.current[cooldownKey] = false; }, 250);
        return true;
    };

    // Reset on hide
    useEffect(() => {
        if (!isVisible || !isAprilFools) {
            setInstallDodge({ x: 0, y: 0, rotate: 0 });
            setOrganizeDodge({ x: 0, y: 0, rotate: 0 });
            setDodgeCount(0);
            dodgeCountRef.current = 0;
            installDodgeRef.current = { x: 0, y: 0, rotate: 0 };
            organizeDodgeRef.current = { x: 0, y: 0, rotate: 0 };
            cooldownRef.current = { install: false, organize: false };
            if (hoverDodgeTimerRef.current) clearTimeout(hoverDodgeTimerRef.current);
        }
    }, [isVisible, isAprilFools]);

    // Dodge on hover (still mouse) — if hoveredZone stays active for 250ms, dodge using last known cursor
    useEffect(() => {
        if (!isAprilFools || dodgeCountRef.current >= maxDodges) return;
        if (hoverDodgeTimerRef.current) clearTimeout(hoverDodgeTimerRef.current);

        if (hoveredZone === 'install' || hoveredZone === 'organize' || hoveredZone === 'new-folder') {
            hoverDodgeTimerRef.current = setTimeout(() => {
                const cardRef = hoveredZone === 'install' ? installCardRef : organizeCardRef;
                const offsetRef = hoveredZone === 'install' ? installDodgeRef : organizeDodgeRef;
                const setOffset = hoveredZone === 'install' ? setInstallDodge : setOrganizeDodge;
                const key = hoveredZone === 'install' ? 'install' : 'organize';
                if (!cardRef.current) return;
                // Use real last cursor position if available
                const cursor = lastCursorRef.current;
                const rect = cardRef.current.getBoundingClientRect();
                const cx = cursor?.x ?? (rect.left + rect.width / 2);
                const cy = cursor?.y ?? (rect.top + rect.height * 0.3);
                doDodge(cardRef, offsetRef, setOffset, key, cx, cy);
            }, 250);
        }

        return () => { if (hoverDodgeTimerRef.current) clearTimeout(hoverDodgeTimerRef.current); };
    }, [hoveredZone, isAprilFools]);

    // Dodge on drag proximity — check both cards, react early
    useEffect(() => {
        if (!isVisible || !isAprilFools) return;

        const handleDragOver = (event: any) => {
            if (dodgeCountRef.current >= maxDodges) return;

            const position = event.payload?.position;
            if (!position) return;
            const { x, y } = position;

            // Always track cursor for hover-dodge fallback
            lastCursorRef.current = { x, y };

            // Check both cards independently — both can dodge in the same frame
            const cards = [
                { ref: installCardRef, offsetRef: installDodgeRef, set: setInstallDodge, key: 'install' as const },
                { ref: organizeCardRef, offsetRef: organizeDodgeRef, set: setOrganizeDodge, key: 'organize' as const },
            ];

            for (const card of cards) {
                if (dodgeCountRef.current >= maxDodges) break;
                if (!card.ref.current || cooldownRef.current[card.key]) continue;
                const rect = card.ref.current.getBoundingClientRect();
                const cx = rect.left + rect.width / 2;
                const cy = rect.top + rect.height / 2;
                const dx = x - cx;
                const dy = y - cy;
                const dist = Math.sqrt(dx * dx + dy * dy);
                // Bigger trigger radius — react before cursor reaches the card
                const triggerRadius = Math.max(rect.width, rect.height) * 0.7;

                if (dist < triggerRadius) {
                    doDodge(card.ref, card.offsetRef, card.set, card.key, x, y);
                }
            }
        };

        const unlistenPromise = listen('tauri://drag-over', handleDragOver);
        return () => { unlistenPromise.then(f => f()); };
    }, [isVisible, isAprilFools]);

    const rootFolder = useMemo(() => folders.find((f: FolderRecord) => f.is_root), [folders]);
    const subfolders = useMemo(() => folders.filter(f => !f.is_root), [folders]);
    const treeData = useMemo(() => {
        const root = buildTree(subfolders);
        return convertToArray(root);
    }, [subfolders]);

    // Reset state when overlay becomes visible
    useEffect(() => {
        if (isVisible) {
            setHoveredZone(null);
            setSelectedFolderId(null);
        }
    }, [isVisible]);

    // Cleanup scroll interval on unmount
    useEffect(() => {
        return () => {
            if (scrollIntervalRef.current) {
                clearInterval(scrollIntervalRef.current);
            }
        };
    }, []);

    // Edge scroll handlers
    const startScrolling = (direction: 'up' | 'down') => {
        if (scrollIntervalRef.current) return;

        const scrollAmount = direction === 'up' ? -8 : 8;
        scrollIntervalRef.current = setInterval(() => {
            if (folderTreeRef.current) {
                folderTreeRef.current.scrollTop += scrollAmount;
            }
        }, 16); // ~60fps
    };

    const stopScrolling = () => {
        if (scrollIntervalRef.current) {
            clearInterval(scrollIntervalRef.current);
            scrollIntervalRef.current = null;
        }
    };

    // Listen to Tauri drag-over event for position-based detection
    useEffect(() => {
        if (!isVisible) return;

        const handleDragOver = (event: any) => {
            const position = event.payload?.position;
            if (!position) return;

            const { x, y } = position;

            // Check if over scroll zones and auto-scroll
            if (folderTreeRef.current) {
                const rect = folderTreeRef.current.getBoundingClientRect();
                const edgeSize = 40; // Size of scroll zone in pixels

                if (y >= rect.top && y <= rect.top + edgeSize && y >= rect.top) {
                    startScrolling('up');
                } else if (y >= rect.bottom - edgeSize && y <= rect.bottom) {
                    startScrolling('down');
                } else {
                    stopScrolling();
                }
            }

            // Find element at this position
            const element = document.elementFromPoint(x, y);
            if (!element) return;

            // Check if over install zone
            const installZone = element.closest('[data-dropzone="install"]');
            if (installZone) {
                setHoveredZone('install');
                setSelectedFolderId(null);
                onInstallDrop?.();
                return;
            }

            // Check if over new-folder drop target
            const newFolderZone = element.closest('[data-dropzone="new-folder"]');
            if (newFolderZone) {
                setHoveredZone('new-folder');
                setSelectedFolderId(null);
                onNewFolderDrop?.();
                return;
            }

            // Check if over a specific folder
            const folderItem = element.closest('[data-folder-id]');
            if (folderItem) {
                const folderId = folderItem.getAttribute('data-folder-id');
                setHoveredZone('organize');
                setSelectedFolderId(folderId);
                onQuickOrganizeDrop?.(folderId);
                return;
            }

            // Check if over organize zone (but not specific folder) - this is
            // the card's own title/description/padding, not empty space
            // outside it, so it should still quick-organize, just to the root
            // folder rather than whichever one happened to be selected last.
            const organizeZone = element.closest('[data-dropzone="organize"]');
            if (organizeZone) {
                setHoveredZone('organize');
                const fallbackFolderId = selectedFolderId ?? rootFolder?.id ?? null;
                setSelectedFolderId(fallbackFolderId);
                if (fallbackFolderId) {
                    onQuickOrganizeDrop?.(fallbackFolderId);
                } else {
                    onInstallDrop?.();
                }
                return;
            }

            // Not over any zone — clear hover state
            setHoveredZone(null);
        };

        const unlistenDragOver = listen('tauri://drag-over', handleDragOver);

        return () => {
            unlistenDragOver.then(f => f());
            stopScrolling();
        };
    }, [isVisible, selectedFolderId, rootFolder, onInstallDrop, onQuickOrganizeDrop, onNewFolderDrop]);

    const handleNewFolder = async (e: React.MouseEvent) => {
        e.stopPropagation();
        const name = prompt('Enter new folder name:');
        if (!name || !name.trim()) return;

        setIsCreatingFolder(true);
        try {
            if (onCreateFolder) {
                const newFolderId = await onCreateFolder(name.trim());
                if (newFolderId) {
                    setSelectedFolderId(newFolderId);
                }
            }
        } catch (err) {
            console.error('Failed to create folder:', err);
        } finally {
            setIsCreatingFolder(false);
        }
    };

    return (
        <AnimatePresence>
            {isVisible && (
                <motion.div
                    ref={overlayRef}
                    className="dropzone-overlay"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                >
                    <div className="dropzone-container">
                        {/* Install Zone */}
                        <motion.div
                            ref={isAprilFools ? installCardRef : undefined}
                            className={`dropzone-card install-zone ${hoveredZone === 'install' ? 'active' : ''}`}
                            data-dropzone="install"
                            initial={{ x: -50, opacity: 0 }}
                            animate={{
                                x: isAprilFools ? installDodge.x : 0,
                                y: isAprilFools ? installDodge.y : 0,
                                rotate: isAprilFools ? installDodge.rotate : 0,
                                opacity: 1,
                            }}
                            transition={isAprilFools && (installDodge.x !== 0 || installDodge.y !== 0)
                                ? { type: 'spring', stiffness: 400, damping: 22, mass: 0.8 }
                                : { delay: 0.1 }
                            }
                        >
                            <div className="zone-icon">
                                <MdInstallDesktop />
                            </div>
                            <h2>Install Mods</h2>
                            <p>Drop files here to open the install panel with full configuration options for legacy .pak files from UE or single-pak old mods.</p>
                            <div className="zone-hint">
                                Supports .pak, .zip, .rar, .7z, folders
                            </div>
                        </motion.div>

                        {/* Quick Organize Zone */}
                        <motion.div
                            ref={isAprilFools ? organizeCardRef : undefined}
                            className={`dropzone-card organize-zone ${hoveredZone === 'organize' ? 'active' : ''}`}
                            data-dropzone="organize"
                            initial={{ x: 50, opacity: 0 }}
                            animate={{
                                x: isAprilFools ? organizeDodge.x : 0,
                                y: isAprilFools ? organizeDodge.y : 0,
                                rotate: isAprilFools ? organizeDodge.rotate : 0,
                                opacity: 1,
                            }}
                            transition={isAprilFools && (organizeDodge.x !== 0 || organizeDodge.y !== 0)
                                ? { type: 'spring', stiffness: 400, damping: 22, mass: 0.8 }
                                : { delay: 0.1 }
                            }
                        >
                            <div className="zone-icon">
                                <MdCreateNewFolder />
                            </div>
                            <h2>Quick Organize</h2>
                            <p>This is for pre-configured mods that are already in the correct format (.pak .utoc .ucas). Hover over a folder below, then drop to install there</p>

                            {/* New Folder Drop Target */}
                            <div
                                className={`new-folder-drop-target ${hoveredZone === 'new-folder' ? 'active' : ''}`}
                                data-dropzone="new-folder"
                            >
                                <VscNewFolder />
                                <span>{hoveredZone === 'new-folder' ? 'Drop to create new folder' : 'Drop here → New Folder'}</span>
                            </div>

                            <div className="folder-tree-wrapper">
                                {/* Scroll zone - Top */}
                                <div
                                    className="scroll-zone scroll-zone-top"
                                    onMouseEnter={() => startScrolling('up')}
                                    onMouseLeave={stopScrolling}
                                />

                                <div className="folder-tree-container" ref={folderTreeRef}>
                                    {/* Root folder */}
                                    {rootFolder && (
                                        <div
                                            className={`drop-folder-item root-item ${selectedFolderId === rootFolder.id ? 'selected' : ''}`}
                                            data-folder-id={rootFolder.id}
                                            data-dropzone="folder"
                                            onClick={() => setSelectedFolderId(rootFolder.id)}
                                        >
                                            <span className="folder-icon"><VscFolderOpened /></span>
                                            <span className="folder-name">{rootFolder.name}</span>
                                        </div>
                                    )}

                                    {/* Subfolders */}
                                    <div className="drop-folder-tree">
                                        {treeData.map(node => (
                                            <DropFolderNode
                                                key={node.fullPath || node.id}
                                                node={node}
                                                selectedFolderId={selectedFolderId}
                                                onSelect={setSelectedFolderId}
                                            />
                                        ))}
                                    </div>
                                </div>

                                {/* Scroll zone - Bottom */}
                                <div
                                    className="scroll-zone scroll-zone-bottom"
                                    onMouseEnter={() => startScrolling('down')}
                                    onMouseLeave={stopScrolling}
                                />
                            </div>

                            {selectedFolderId && (
                                <div className="selected-folder-hint">
                                    Drop to install into: <strong>{selectedFolderId}</strong>
                                </div>
                            )}
                        </motion.div>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default DropZoneOverlay;

