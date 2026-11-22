import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { VscClose, VscNewFolder } from 'react-icons/vsc';
import './InputPromptModal.css';
import { useDialog } from '../hooks/useDialog'

type InputPromptModalProps = {
    isOpen: boolean;
    title?: string;
    placeholder?: string;
    confirmText?: string;
    cancelText?: string;
    icon?: React.ReactNode;
    onConfirm: (value: string) => void;
    onCancel: () => void;
    initialValue?: string;
    accentColor?: string;
    mode?: 'input' | 'confirm' | 'choice';
    description?: string;
    /** 'choice' mode: one button per option, clicking it confirms with its value */
    options?: { value: string; label: React.ReactNode; detail?: string }[];
    /** 'choice' mode: extra content between the description and the options */
    children?: React.ReactNode;
};

/**
 * A styled input prompt modal to replace browser's prompt()
 * 
 * @param {Object} props
 * @param {boolean} props.isOpen - Whether the modal is visible
 * @param {string} props.title - Modal title
 * @param {string} props.placeholder - Input placeholder text
 * @param {string} props.confirmText - Confirm button text
 * @param {string} props.cancelText - Cancel button text (default: "Cancel")
 * @param {React.ReactNode} props.icon - Icon to display in header
 * @param {function} props.onConfirm - Called with input value when confirmed
 * @param {function} props.onCancel - Called when cancelled
 * @param {string} props.initialValue - Initial input value
 * @param {string} props.accentColor - Optional accent color (default uses CSS variable)
 */
const InputPromptModal = ({
    isOpen,
    title = 'Enter value',
    placeholder = 'Enter value...',
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    icon = <VscNewFolder />,
    onConfirm,
    onCancel,
    initialValue = '',
    accentColor = '',
    mode = 'input',
    children,
    description = '',
    options = []
}: InputPromptModalProps) => {
    const dialog = useDialog(onCancel, title)
    const [value, setValue] = useState(initialValue);
    const inputRef = useRef<HTMLInputElement | null>(null);

    // Reset value and focus input when modal opens
    useEffect(() => {
        if (isOpen) {
            setValue(initialValue);
            // Small delay to ensure modal is rendered before focusing
            setTimeout(() => {
                inputRef.current?.focus();
                inputRef.current?.select();
            }, 100);
        }
    }, [isOpen, initialValue]);

    const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (mode === 'confirm') {
            onConfirm('');
        } else if (value.trim()) {
            onConfirm(value.trim());
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Escape') {
            onCancel();
        }
    };

    const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (e.target === e.currentTarget) {
            onCancel();
        }
    };

    const style = accentColor ? { '--prompt-accent': accentColor } as React.CSSProperties : {};

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    className="input-prompt-overlay"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    onClick={handleBackdropClick}
                    onKeyDown={handleKeyDown}
                    style={style}
                >
                    <motion.div
                        {...dialog}
                className="input-prompt-modal"
                        initial={{ y: -20, opacity: 0, scale: 0.95 }}
                        animate={{ y: 0, opacity: 1, scale: 1 }}
                        exit={{ y: -20, opacity: 0, scale: 0.95 }}
                        transition={{ duration: 0.2, ease: 'easeOut' }}
                    >
                        {/* Header */}
                        <div className="prompt-header">
                            <div className="prompt-icon">
                                {icon}
                            </div>
                            <h3>{title}</h3>
                            <button aria-label="Close" className="prompt-close" onClick={onCancel}>
                                <VscClose />
                            </button>
                        </div>

                        {/* Content */}
                        <form onSubmit={handleSubmit} className="prompt-content">
                            {mode === 'choice' ? (
                                <>
                                    {description && <p className="prompt-description">{description}</p>}
                                    {children}
                                    {options.map(o => (
                                        <button key={o.value} type="button" className="prompt-option" onClick={() => onConfirm(o.value)}>
                                            <span className="prompt-option-label">{o.label}</span>
                                            {o.detail && <span className="prompt-option-detail">{o.detail}</span>}
                                        </button>
                                    ))}
                                </>
                            ) : mode === 'confirm' ? (
                                <p className="prompt-description">{description}</p>
                            ) : (
                                <input
                                    ref={inputRef}
                                    type="text"
                                    value={value}
                                    onChange={(e) => setValue(e.target.value)}
                                    placeholder={placeholder}
                                    className="prompt-input"
                                    autoFocus
                                />
                            )}

                            {/* Actions */}
                            <div className="prompt-actions">
                                <button
                                    type="button"
                                    className="prompt-btn prompt-btn-cancel"
                                    onClick={onCancel}
                                >
                                    {cancelText}
                                </button>
                                {mode !== 'choice' && (
                                    <button
                                        type="submit"
                                        className="prompt-btn prompt-btn-confirm"
                                        disabled={mode === 'input' && !value.trim()}
                                        title={mode === 'input' && !value.trim() ? 'Type a name first' : undefined}
                                    >
                                        {confirmText}
                                    </button>
                                )}
                            </div>
                        </form>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default InputPromptModal;
