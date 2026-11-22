import React, { useState, useEffect, useRef } from 'react';
import './CustomDropdown.css';

type DropdownOption = string | { value: string; label: string; showDelete?: boolean };

type CustomDropdownProps = {
    options?: DropdownOption[];
    value?: string;
    onChange: (value: string) => void;
    placeholder?: string;
    icon?: React.ReactNode;
    className?: string;
    disabled?: boolean;
    onAddNew?: () => void;
    addNewLabel?: React.ReactNode;
    onDeleteOption?: (value: string) => void;
    alwaysShowDeleteIcon?: boolean;
    /** Shown right after the selected label in the trigger (e.g. an unsaved marker) */
    valueSuffix?: React.ReactNode;
    /** Extra commands shown side by side under the options, above "Add New" */
    actions?: { label: string; onClick: () => void; title?: string; icon?: React.ReactNode }[];
    /** Double-clicking an option edits its label in place; called with the new label */
    onRenameOption?: (value: string, label: string) => void;
};

/** How long a click waits to see if it becomes a double-click (rename) */
const DOUBLE_CLICK_MS = 250;

/**
 * A generic custom dropdown component.
 * 
 * @param {Object} props
 * @param {Array<string|{value: string, label: string}>} props.options - List of options to display
 * @param {string} props.value - Currently selected value
 * @param {Function} props.onChange - Callback when an option is selected
 * @param {string} props.placeholder - Text to display when no value is selected
 * @param {string} props.className - Optional additional classes
 * @param {boolean} props.disabled - Whether the dropdown is disabled
 */
const CustomDropdown = ({
    options = [],
    value,
    onChange,
    placeholder = "Select...",
    icon = null,
    className = "",
    disabled = false,
    onAddNew,
    addNewLabel = "+ Add New",
    onDeleteOption,
    alwaysShowDeleteIcon = false,
    valueSuffix,
    actions = [],
    onRenameOption
}: CustomDropdownProps) => {
    const [isOpen, setIsOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement | null>(null);
    /** Option being renamed in place, and its draft label */
    const [editing, setEditing] = useState<{ value: string; original: string; text: string } | null>(null);
    const editingRef = useRef(editing);
    editingRef.current = editing;
    const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const commitRename = () => {
        const current = editingRef.current;
        setEditing(null);
        const text = current?.text.trim();
        if (current && text && text !== current.original) {
            onRenameOption?.(current.value, text);
        }
    };

    // Close dropdown when clicking outside (keeping a rename in progress)
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && event.target instanceof Node && !dropdownRef.current.contains(event.target)) {
                // The input unmounts with the menu before its blur would fire
                if (editingRef.current) commitRename();
                setIsOpen(false);
            }
        };

        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isOpen]);

    const handleToggle = () => {
        if (!disabled) {
            setIsOpen(!isOpen);
        }
    };

    const handleSelect = (option: DropdownOption) => {
        const optionValue = typeof option === 'string' ? option : option.value;
        onChange(optionValue);
        setIsOpen(false);
    };

    // Helper to get display label
    const getLabel = (val?: string) => {
        if (!val) return placeholder;
        const found = options.find(opt => (typeof opt === 'string' ? opt : opt.value) === val);
        if (!found) return val; // Fallback to value if option not found
        return typeof found === 'string' ? found : found.label;
    };

    return (
        <div className={`custom-dropdown-container ${className}`} ref={dropdownRef}>
            <button
                className={`custom-dropdown-trigger ${isOpen ? 'open' : ''} ${value ? 'active' : ''}`}
                onClick={handleToggle}
                title={getLabel(value)}
                disabled={disabled}
                style={disabled ? { opacity: 0.6, cursor: 'not-allowed' } : {}}
            >
                {icon && <span className="custom-dropdown-icon">{icon}</span>}
                <span className={`custom-dropdown-text ${valueSuffix ? 'has-suffix' : ''}`}>{getLabel(value)}</span>
                {valueSuffix}
            </button>

            {isOpen && !disabled && (
                <div className="custom-dropdown-menu">
                    {/* Optional "Clear" or "All" option if placeholder suggests it */}
                    {/* For now, we assume parent handles specific "All" options by passing them in options array if needed, 
                        BUT for consistency with previous Tag behavior, if value is present, we might want a way to clear it?
                        Actually, existing TagFilterDropdown had an "All Tags" option hardcoded. 
                        Let's make sure the parent provides "All Tags" as an option if desired. 
                     */}

                    {options.length === 0 ? (
                        <div className="custom-dropdown-item disabled">
                            No options
                        </div>
                    ) : (
                        options.map((option, index) => {
                            const optValue = typeof option === 'string' ? option : option.value;
                            const optLabel = typeof option === 'string' ? option : option.label;
                            const optShowDelete = typeof option === 'string' ? true : option.showDelete === true;
                            const isSelected = optValue === value;

                            // Optional separator logic could be passed in, but for now simple list
                            return (
                                <div
                                    key={`${optValue}-${index}`}
                                    className={`custom-dropdown-item ${isSelected ? 'selected' : ''} ${editing?.value === optValue ? 'editing' : ''}`}
                                    onClick={() => {
                                        if (editing) return;
                                        if (!onRenameOption) return handleSelect(option);
                                        // Wait: a second click turns this into a rename, not a selection
                                        if (clickTimer.current) clearTimeout(clickTimer.current);
                                        clickTimer.current = setTimeout(() => handleSelect(option), DOUBLE_CLICK_MS);
                                    }}
                                    onDoubleClick={() => {
                                        if (!onRenameOption) return;
                                        if (clickTimer.current) clearTimeout(clickTimer.current);
                                        setEditing({ value: optValue, original: optLabel, text: optLabel });
                                    }}
                                    title={onRenameOption ? `${optLabel} (double-click to rename)` : optLabel}
                                >
                                    {editing?.value === optValue ? (
                                        <input
                                            className="custom-dropdown-rename-input"
                                            autoFocus
                                            onFocus={e => e.target.select()}
                                            value={editing.text}
                                            onChange={e => setEditing({ ...editing, text: e.target.value })}
                                            onClick={e => e.stopPropagation()}
                                            onKeyDown={e => {
                                                e.stopPropagation();
                                                if (e.key === 'Enter') commitRename();
                                                else if (e.key === 'Escape') setEditing(null);
                                            }}
                                            onBlur={commitRename}
                                        />
                                    ) : (
                                        <span className="custom-dropdown-item-label">{optLabel}</span>
                                    )}
                                    {onDeleteOption && optValue && optShowDelete && editing?.value !== optValue && (
                                        <button
                                            className={`custom-dropdown-item-delete ${alwaysShowDeleteIcon ? 'always-visible' : ''}`}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onDeleteOption(optValue);
                                            }}
                                            title={`Remove "${optLabel}"`}
                                        >
                                            ×
                                        </button>
                                    )}
                                </div>
                            );
                        })
                    )}
                    {actions.length > 0 && (
                        <>
                            <div className="custom-dropdown-separator" />
                            <div className="custom-dropdown-actions">
                                {actions.map(action => (
                                    <button
                                        key={action.label}
                                        type="button"
                                        className="custom-dropdown-action"
                                        title={action.title}
                                        onClick={() => { action.onClick(); setIsOpen(false); }}
                                    >
                                        {action.icon}
                                        {action.label}
                                    </button>
                                ))}
                            </div>
                        </>
                    )}
                    {onAddNew && (
                        <>
                            <div className="custom-dropdown-separator" />
                            <div
                                className="custom-dropdown-item add-new"
                                onClick={() => { onAddNew(); setIsOpen(false); }}
                            >
                                {addNewLabel}
                            </div>
                        </>
                    )}
                </div>
            )}
        </div>
    );
};

export default CustomDropdown;
