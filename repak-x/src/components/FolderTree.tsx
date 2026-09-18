import React, { useState, useMemo, useEffect } from 'react';
import { VscFolder, VscFolderOpened, VscLibrary, VscChevronRight, VscChevronDown } from 'react-icons/vsc';
import './FolderTree.css';

type FolderRecord = {
    id: string;
    name: string;
    is_root?: boolean;
};

type TreeNodeMap = {
    id?: string;
    name: string;
    children: Record<string, TreeNodeMap>;
    isVirtual: boolean;
    fullPath?: string;
    originalName?: string;
};

type TreeNode = Omit<TreeNodeMap, 'children'> & {
    children: TreeNode[];
};

type FolderNodeProps = {
    node: TreeNode;
    selectedFolderId: string;
    onSelect: (folderId: string) => void;
    onDelete: (folderId: string) => void;
    getCount: (folderId: string) => number;
    hasFilters: boolean;
    onContextMenu?: (e: React.MouseEvent, folder: FolderRecord) => void;
};

type FolderTreeProps = {
    folders: FolderRecord[];
    selectedFolderId: string;
    onSelect: (folderId: string) => void;
    onDelete: (folderId: string) => void;
    getCount: (folderId: string) => number;
    hasFilters: boolean;
    onContextMenu?: (e: React.MouseEvent, folder: FolderRecord) => void;
    hideAllMods?: boolean;
};

const buildTree = (folders: FolderRecord[]): TreeNodeMap => {
    const root: TreeNodeMap = { id: 'root', name: 'root', children: {}, isVirtual: true };

    // Sort folders by name to ensure consistent tree building
    const sortedFolders = [...folders].sort((a, b) => a.name.localeCompare(b.name));

    sortedFolders.forEach((folder) => {
        // Split by '/' or '\'
        const parts = folder.id.split(/[/\\]/);
        let current = root;

        parts.forEach((part: string, index: number) => {
            if (!current.children[part]) {
                current.children[part] = {
                    name: part,
                    children: {},
                    isVirtual: true,
                    fullPath: parts.slice(0, index + 1).join('/')
                };
            }
            current = current.children[part];

            // If this is the last part, it's the actual folder
            if (index === parts.length - 1) {
                current.id = folder.id;
                current.isVirtual = false;
                current.originalName = folder.name;
            }
        });
    });

    return root;
};

const convertToArray = (node: TreeNodeMap): TreeNode[] => {
    if (!node.children) return [];
    const children = Object.values(node.children).map((child) => ({
        ...child,
        children: convertToArray(child)
    }));
    // Sort: folders with children first? or alphabetical?
    // Let's stick to alphabetical for now
    children.sort((a, b) => a.name.localeCompare(b.name));
    return children;
};

const FolderNode = ({ node, selectedFolderId, onSelect, onDelete, getCount, hasFilters, onContextMenu }: FolderNodeProps) => {
    const [isOpen, setIsOpen] = useState(false);
    const hasChildren = node.children && node.children.length > 0;

    // Auto-expand if a child is selected
    useEffect(() => {
        const containsSelection = (n: TreeNode): boolean => {
            if (n.id === selectedFolderId) return true;
            if (n.children) {
                return n.children.some(containsSelection);
            }
            return false;
        };
        if (containsSelection(node)) {
            setIsOpen(true);
        }
    }, [selectedFolderId, node]);

    const handleToggle = () => {
        // e.stopPropagation(); // Allow click to bubble to close context menu
        setIsOpen(!isOpen);
    };

    const handleSelect = () => {
        // e.stopPropagation(); // Allow click to bubble to close context menu
        if (!node.isVirtual && node.id) {
            onSelect(node.id);
        } else {
            // If virtual, maybe just toggle?
            setIsOpen(!isOpen);
        }
    };

    const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!node.isVirtual && node.id && onContextMenu) {
            e.preventDefault();
            e.stopPropagation();
            onContextMenu(e, { id: node.id, name: node.name });
        }
    };

    const count = !node.isVirtual && node.id ? getCount(node.id) : 0;

    // Hide empty folders when filters are active (only for real folders)
    if (hasFilters && !node.isVirtual && count === 0 && !hasChildren) return null;
    // If virtual and no children visible (due to filter), we might want to hide it too?
    // But calculating that is complex. Let's rely on the fact that if children are hidden, this node will be empty.
    // Actually, if hasFilters is true, we might want to hide virtual nodes that have no visible children.
    // For now, let's just hide real empty folders.

    const isSelected = selectedFolderId === node.id;

    return (
        <div className="folder-tree-node">
            <div
                className={`node-content ${isSelected ? 'selected' : ''} ${node.isVirtual ? 'virtual' : ''}`}
                onClick={handleSelect}
                onContextMenu={handleContextMenu}
                style={{ opacity: node.isVirtual ? 0.8 : 1 }}
                title={node.isVirtual ? 'Virtual Folder (Group)' : node.originalName}
            >
                <span
                    className="node-toggle-icon"
                    onClick={handleToggle}
                    style={{
                        width: '20px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        visibility: hasChildren ? 'visible' : 'hidden'
                    }}
                >
                    {isOpen ? <VscChevronDown /> : <VscChevronRight />}
                </span>

                <span className="node-icon folder-icon">
                    {isSelected || (isOpen && hasChildren) ? <VscFolderOpened /> : <VscFolder />}
                </span>

                <span className="node-label" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {node.name}
                </span>

                {!node.isVirtual && count !== undefined && (
                    <span className="folder-count">
                        {count}
                    </span>
                )}
            </div>

            {hasChildren && isOpen && (
                <div className="node-children">
                    {node.children.map((child: TreeNode) => (
                        <FolderNode
                            key={child.fullPath || child.id}
                            node={child}
                            selectedFolderId={selectedFolderId}
                            onSelect={onSelect}
                            onDelete={onDelete}
                            getCount={getCount}
                            hasFilters={hasFilters}
                            onContextMenu={onContextMenu}
                        />
                    ))}
                </div>
            )}
        </div>
    );
};

const FolderTree = ({ folders, selectedFolderId, onSelect, onDelete, getCount, hasFilters, onContextMenu, hideAllMods = false }: FolderTreeProps) => {
    // Separate root folder from subfolders
    const rootFolder = useMemo(() => folders.find((f: FolderRecord) => f.is_root), [folders]);
    const subfolders = useMemo(() => folders.filter((f: FolderRecord) => !f.is_root), [folders]);

    // State for root folder expansion
    const [isRootOpen, setIsRootOpen] = useState(true);

    const treeData = useMemo(() => {
        const root = buildTree(subfolders);
        return convertToArray(root);
    }, [subfolders]);

    const handleRootToggle = () => {
        // e.stopPropagation(); // Allow click to bubble to close context menu
        setIsRootOpen(!isRootOpen);
    };

    return (
        <div className="folder-tree" style={{ padding: 0 }}>
            {/* All Mods Root Node */}
            {!hideAllMods && (
                <div className="folder-tree-node">
                    <div
                        className={`node-content all-mods ${selectedFolderId === 'all' ? 'selected' : ''}`}
                        onClick={() => onSelect('all')}
                    >
                        <span className="node-icon folder-icon">
                            <VscLibrary />
                        </span>
                        <span className="node-label">All Mods</span>
                        <span className="folder-count">
                            {getCount('all')}
                        </span>
                    </div>
                </div>
            )}

            {/* Root Folder (~mods) - Display separately */}
            {rootFolder && (
                <div className="folder-tree-node">
                    <div
                        className={`node-content ${selectedFolderId === rootFolder.id ? 'selected' : ''}`}
                        onClick={() => onSelect(rootFolder.id)}
                        onContextMenu={(e) => {
                            if (!onContextMenu) return;
                            e.preventDefault();
                            e.stopPropagation();
                            onContextMenu(e, { id: rootFolder.id, name: rootFolder.name, is_root: true });
                        }}
                    >
                        <span
                            className="node-toggle-icon"
                            onClick={handleRootToggle}
                            style={{
                                width: '20px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                cursor: 'pointer',
                                visibility: 'visible'
                            }}
                        >
                            {isRootOpen ? <VscChevronDown /> : <VscChevronRight />}
                        </span>

                        <span className="node-icon folder-icon">
                            {selectedFolderId === rootFolder.id ? <VscFolderOpened /> : <VscFolder />}
                        </span>
                        <span className="node-label">{rootFolder.name}</span>
                        <span className="folder-count">
                            {getCount(rootFolder.id)}
                        </span>
                    </div>

                    {/* Render subfolders as children of root */}
                    {isRootOpen && (
                        <div className="node-children">
                            {treeData.map((node: TreeNode) => (
                                <FolderNode
                                    key={node.fullPath || node.id}
                                    node={node}
                                    selectedFolderId={selectedFolderId}
                                    onSelect={onSelect}
                                    onDelete={onDelete}
                                    getCount={getCount}
                                    hasFilters={hasFilters}
                                    onContextMenu={onContextMenu}
                                />
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default FolderTree;
