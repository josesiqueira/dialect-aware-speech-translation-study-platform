/**
 * Shared UI primitives. Import from "@/components/ui".
 * Catalog and rules: design-system/COMPONENTS.md.
 */
export { cn } from "./cn";
export {
  focusRing,
  scrollRegionProps,
  inputBase,
  inputSizes,
  labelBase,
  overlineLabel,
  filterControl,
  tableClasses,
  type InputSize,
} from "./styles";
export * from "./icons";
export { VisuallyHidden } from "./VisuallyHidden";
export { Spinner, type SpinnerProps } from "./Spinner";
export {
  Button,
  buttonClasses,
  type ButtonProps,
  type ButtonSize,
  type ButtonVariant,
  type ButtonStyleOptions,
} from "./Button";
export { LinkButton, type LinkButtonProps } from "./LinkButton";
export {
  Card,
  CardHeader,
  CardBody,
  type CardProps,
  type CardHeaderProps,
  type CardVariant,
  type CardPadding,
} from "./Card";
export { PageHeading, type PageHeadingProps } from "./PageHeading";
export { SectionHeading, type SectionHeadingProps } from "./SectionHeading";
export { Badge, BADGE_VARIANTS, type BadgeProps, type BadgeVariant } from "./Badge";
export { MetricCard, type MetricCardProps } from "./MetricCard";
export { FormField, useFieldControl, type FormFieldProps, type FieldControlProps } from "./FormField";
export { TextInput, type TextInputProps } from "./TextInput";
export { TextArea, type TextAreaProps } from "./TextArea";
export { Select, type SelectProps, type SelectOption } from "./Select";
export { Checkbox, type CheckboxProps } from "./Checkbox";
export { RadioGroup, type RadioGroupProps, type RadioOption } from "./RadioGroup";
export { LikertScale, type LikertScaleProps } from "./LikertScale";
export {
  InlineMessage,
  InlineStatus,
  type InlineMessageProps,
  type InlineStatusProps,
  type MessageVariant,
} from "./InlineMessage";
export {
  LoadingState,
  EmptyState,
  ErrorState,
  type LoadingStateProps,
  type EmptyStateProps,
  type ErrorStateProps,
} from "./States";
export { ConfirmDialog, type ConfirmDialogProps } from "./ConfirmDialog";
export { Pagination, type PaginationProps } from "./Pagination";
export { DataTable, type DataTableProps, type DataTableColumn } from "./DataTable";
export { ListRowButton, type ListRowButtonProps } from "./ListRowButton";
export { KeyValueList, type KeyValueListProps, type KeyValueItem } from "./KeyValueList";
export { CopyableId, type CopyableIdProps } from "./CopyableId";
export { AudioPlayer, type AudioPlayerProps } from "./AudioPlayer";
export { ProgressBar, type ProgressBarProps } from "./ProgressBar";
export {
  FilterBar,
  FilterSelect,
  FilterDateInput,
  FilterSearch,
  ClearFiltersButton,
  type FilterBarProps,
  type FilterSelectProps,
  type FilterDateInputProps,
  type FilterSearchProps,
  type ClearFiltersButtonProps,
} from "./FilterBar";
export {
  useUnsavedChangesGuard,
  confirmDiscardChanges,
  UNSAVED_CHANGES_MESSAGE,
} from "./useUnsavedChangesGuard";
export { SaveButton, type SaveButtonProps, type SaveStatus } from "./SaveButton";
export { RefreshButton, type RefreshButtonProps } from "./RefreshButton";
