import { useState, useEffect, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import './OnboardingTour.css'

type Placement = 'top' | 'bottom' | 'left' | 'right'

type TourStep = {
    target: string
    title: string
    description: string
    placement: Placement
}

type TooltipPosition = {
    top: number
    left: number
    actualPlacement: Placement
    arrowOffset: number
}

type OnboardingTourProps = {
    isOpen: boolean
    onClose: () => void
}

const TOUR_STEPS: TourStep[] = [
    {
        target: '[data-tour="header-branding"]',
        title: 'Welcome to Repak X',
        description: "Your all-in-one Marvel Rivals mod manager and installer. Here's a quick tour of the main features.",
        placement: 'bottom',
    },
    {
        target: '[data-tour="search-bar"]',
        title: 'Search Mods',
        description: 'Quickly find any installed mod by name. Use Ctrl+F to focus the search bar anytime.',
        placement: 'bottom',
    },
    {
        target: '[data-tour="add-mod-btn"]',
        title: 'Add Mods',
        description: 'Click here or drag & drop files onto the app to install new mods. Supports .pak files, archives, and folders.',
        placement: 'bottom',
    },
    {
        target: '[data-tour="folder-sidebar"]',
        title: 'Folders & Filters',
        description: 'Organize mods into folders and filter them by character or mod type.',
        placement: 'right',
    },
    {
        target: '[data-tour="mod-list"]',
        title: 'Your Mods',
        description: 'All your installed mods live here! Toggle them on/off, rename, change priority, right-click for more options, or select multiple for bulk actions.',
        placement: 'top',
    },
    {
        target: '[data-tour="header-actions"]',
        title: 'List Controls',
        description: 'Check for mod conflicts, switch between Grid and List views, toggle the details side-panel, and manually refresh your mod list.',
        placement: 'bottom',
    },
    {
        target: '[data-tour="vfx-updater-btn"]',
        title: 'VFX Updater',
        description: "Quickly port outdated VFX mods to the latest game version. Opens a dedicated tool that automatically extracts, converts, patches, and repacks the VFX assets so your mods keep working after game updates.",
        placement: 'bottom',
    },
    {
        target: '[data-tour="sharing-btn"]',
        title: 'Share Modpacks',
        description: 'Create and share modpacks securely with other Repak X users across the globe.',
        placement: 'bottom',
    },
    {
        target: '[data-tour="tools-btn"]',
        title: 'Tools',
        description: 'Access additional tools like Skip Launcher, update Heroes database, re-compress mods, and other utilities.',
        placement: 'bottom',
    },
    {
        target: '[data-tour="launch-btn"]',
        title: 'Launch Game',
        description: 'Launch Marvel Rivals via Steam directly from here. The app will detect when the game is running to prevent you from making any breaking changes to your mods.',
        placement: 'bottom',
    },
    {
        target: '[data-tour="settings-btn"]',
        title: 'Settings',
        description: 'Configure your game path and app preferences to your liking. You can replay this tour from Settings anytime.',
        placement: 'left',
    },
]

const PADDING = 8
const TOOLTIP_GAP = 20
const VIEWPORT_MARGIN = 12

function getTargetRect(selector: string): DOMRect | null {
    const el = document.querySelector<HTMLElement>(selector)
    if (!el) return null
    return el.getBoundingClientRect()
}

function computeTooltipPosition(targetRect: DOMRect | null, placement: Placement, tooltipWidth: number, tooltipHeight: number): TooltipPosition {
    if (!targetRect) return { top: 0, left: 0, actualPlacement: placement, arrowOffset: 50 }

    const cutout = {
        top: targetRect.top - PADDING,
        left: targetRect.left - PADDING,
        width: targetRect.width + PADDING * 2,
        height: targetRect.height + PADDING * 2,
    }

    const targetCenterX = cutout.left + cutout.width / 2
    const targetCenterY = cutout.top + cutout.height / 2
    const vw = window.innerWidth
    const vh = window.innerHeight

    let top = 0
    let left = 0
    let actualPlacement = placement

    const calcPosition = (p: Placement): { top: number; left: number } => {
        switch (p) {
            case 'bottom':
                return { top: cutout.top + cutout.height + TOOLTIP_GAP, left: targetCenterX - tooltipWidth / 2 }
            case 'top':
                return { top: cutout.top - tooltipHeight - TOOLTIP_GAP, left: targetCenterX - tooltipWidth / 2 }
            case 'right':
                return { top: targetCenterY - tooltipHeight / 2, left: cutout.left + cutout.width + TOOLTIP_GAP }
            case 'left':
                return { top: targetCenterY - tooltipHeight / 2, left: cutout.left - tooltipWidth - TOOLTIP_GAP }
            default:
                return { top: cutout.top + cutout.height + TOOLTIP_GAP, left: targetCenterX - tooltipWidth / 2 }
        }
    }

    const fitsMainAxis = (p: Placement, pos: { top: number; left: number }): boolean => {
        switch (p) {
            case 'bottom': return pos.top + tooltipHeight <= vh - VIEWPORT_MARGIN
            case 'top': return pos.top >= VIEWPORT_MARGIN
            case 'right': return pos.left + tooltipWidth <= vw - VIEWPORT_MARGIN
            case 'left': return pos.left >= VIEWPORT_MARGIN
            default: return true
        }
    }

    let pos = calcPosition(placement)
    if (!fitsMainAxis(placement, pos)) {
        const allPlacements: Placement[] = ['bottom', 'top', 'right', 'left']
        const fallbacks = allPlacements.filter((p) => p !== placement)
        for (const fb of fallbacks) {
            const fbPos = calcPosition(fb)
            if (fitsMainAxis(fb, fbPos)) {
                pos = fbPos
                actualPlacement = fb
                break
            }
        }
    }

    top = pos.top
    left = pos.left

    left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - tooltipWidth - VIEWPORT_MARGIN))
    top = Math.max(VIEWPORT_MARGIN, Math.min(top, vh - tooltipHeight - VIEWPORT_MARGIN))

    let arrowOffset = 50
    if (actualPlacement === 'bottom' || actualPlacement === 'top') {
        const arrowPx = targetCenterX - left
        arrowOffset = Math.max(10, Math.min(90, (arrowPx / tooltipWidth) * 100))
    } else {
        const arrowPx = targetCenterY - top
        arrowOffset = Math.max(10, Math.min(90, (arrowPx / tooltipHeight) * 100))
    }

    return { top, left, actualPlacement, arrowOffset }
}

function OnboardingTour({ isOpen, onClose }: OnboardingTourProps) {
    const [currentStep, setCurrentStep] = useState(0)
    const [targetRect, setTargetRect] = useState<DOMRect | null>(null)
    const [tooltipPos, setTooltipPos] = useState<TooltipPosition>({ top: 0, left: 0, actualPlacement: 'bottom', arrowOffset: 50 })
    const tooltipRef = useRef<HTMLDivElement | null>(null)

    const step = TOUR_STEPS[currentStep]

    const updatePositions = useCallback(() => {
        if (!isOpen || !step) return

        const rect = getTargetRect(step.target)
        setTargetRect(rect)

        if (rect && tooltipRef.current) {
            const tw = tooltipRef.current.offsetWidth
            const th = tooltipRef.current.offsetHeight
            const pos = computeTooltipPosition(rect, step.placement, tw, th)
            setTooltipPos(pos)
        }
    }, [isOpen, step])

    useEffect(() => {
        if (!isOpen) {
            setCurrentStep(0)
            return
        }

        const el = document.querySelector<HTMLElement>(step.target)
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        }

        const frame = requestAnimationFrame(() => {
            requestAnimationFrame(updatePositions)
        })

        return () => cancelAnimationFrame(frame)
    }, [isOpen, currentStep, step, updatePositions])

    useEffect(() => {
        if (!isOpen) return

        const handleResize = () => updatePositions()
        window.addEventListener('resize', handleResize)
        return () => window.removeEventListener('resize', handleResize)
    }, [isOpen, updatePositions])

    useEffect(() => {
        if (!isOpen) return

        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose()
            } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
                if (currentStep < TOUR_STEPS.length - 1) {
                    setCurrentStep(s => s + 1)
                } else {
                    onClose()
                }
            } else if (e.key === 'ArrowLeft') {
                if (currentStep > 0) setCurrentStep(s => s - 1)
            }
        }
        window.addEventListener('keydown', handleKey)
        return () => window.removeEventListener('keydown', handleKey)
    }, [isOpen, currentStep, onClose])

    if (!isOpen) return null

    const cutoutStyle = targetRect ? {
        top: targetRect.top - PADDING,
        left: targetRect.left - PADDING,
        width: targetRect.width + PADDING * 2,
        height: targetRect.height + PADDING * 2,
    } : null

    const isFirst = currentStep === 0
    const isLast = currentStep === TOUR_STEPS.length - 1

    return (
        <div className="onboarding-overlay">
            <AnimatePresence mode="wait">
                {cutoutStyle && (
                    <motion.div
                        key={`cutout-${currentStep}`}
                        className="onboarding-cutout"
                        initial={false}
                        animate={{
                            top: cutoutStyle.top,
                            left: cutoutStyle.left,
                            width: cutoutStyle.width,
                            height: cutoutStyle.height,
                        }}
                        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                    />
                )}
            </AnimatePresence>

            <AnimatePresence mode="wait">
                <motion.div
                    key={`tooltip-${currentStep}`}
                    ref={tooltipRef}
                    className="onboarding-tooltip"
                    data-placement={tooltipPos.actualPlacement}
                    style={{
                        top: tooltipPos.top,
                        left: tooltipPos.left,
                    }}
                    initial={{ opacity: 0, scale: 0.92 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.92 }}
                    transition={{ duration: 0.25, ease: 'easeOut' }}
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="onboarding-tooltip-arrow" style={{ '--arrow-offset': `${tooltipPos.arrowOffset || 50}%` } as React.CSSProperties} />

                    <div className="onboarding-tooltip-content">
                        <h3 className="onboarding-tooltip-title">{step.title}</h3>
                        <p className="onboarding-tooltip-desc">{step.description}</p>
                    </div>

                    <div className="onboarding-step-counter">
                        {currentStep + 1} of {TOUR_STEPS.length}
                    </div>

                    <div className="onboarding-tooltip-footer">
                        <div className="onboarding-dots">
                            {TOUR_STEPS.map((_, i) => (
                                <button
                                    key={i}
                                    className={`onboarding-dot ${i === currentStep ? 'active' : ''}`}
                                    onClick={() => setCurrentStep(i)}
                                />
                            ))}
                        </div>

                        <div className="onboarding-actions">
                            <button className="onboarding-skip-btn" onClick={onClose} style={{ opacity: '0.7' }}>
                                Skip Tour
                            </button>
                            {!isFirst && (
                                <button
                                    className="onboarding-back-btn"
                                    onClick={() => setCurrentStep(s => s - 1)}
                                >
                                    Back
                                </button>
                            )}
                            <button
                                className="onboarding-next-btn"
                                onClick={() => {
                                    if (isLast) {
                                        onClose()
                                    } else {
                                        setCurrentStep(s => s + 1)
                                    }
                                }}
                            >
                                {isLast ? 'Finish' : 'Next'}
                            </button>
                        </div>
                    </div>
                </motion.div>
            </AnimatePresence>
        </div>
    )
}

export default OnboardingTour
