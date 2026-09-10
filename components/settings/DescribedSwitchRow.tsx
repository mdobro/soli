import { Platform } from 'react-native'
import { Column, Row, Spacer, Switch, Text } from '@expo/ui'
import { weight } from '@expo/ui/jetpack-compose/modifiers'

type DescribedSwitchRowProps = {
  label: string
  description: string
  value: boolean
  onValueChange: (value: boolean) => void
  // Greys the label + description and makes the switch inert. For rows whose
  // effect depends on another setting, so an unusable row reads as unusable
  // instead of silently doing nothing when flipped.
  disabled?: boolean
}

// Settings row: label + secondary description + trailing switch. Composed from
// @expo/ui primitives (the DrawCountPreference pattern) instead of the
// universal ListItem: FieldGroup.Section on Android already wraps every row in
// a Compose ListItem, so nesting another ListItem would double-wrap paddings.
// Layout note: on Android the label column takes the leftover width via a
// Compose weight modifier (weighted children measure LAST, so the switch keeps
// its intrinsic size and long descriptions wrap instead of squeezing it out);
// on iOS the SwiftUI HStack handles that naturally with a flexible spacer.
// Same mid-gray family as the description, stepped down so a disabled row
// still reads on both Host themes without looking like an empty slot.
const DISABLED_LABEL_COLOR = '#8E8E93'
const DISABLED_DESCRIPTION_COLOR = '#5A5A5F'

export const DescribedSwitchRow = ({
  label,
  description,
  value,
  onValueChange,
  disabled = false,
}: DescribedSwitchRowProps) => (
  <Row alignment="center" spacing={12}>
    <Column spacing={2} modifiers={Platform.OS === 'android' ? [weight(1)] : undefined}>
      <Text textStyle={disabled ? { color: DISABLED_LABEL_COLOR } : undefined}>{label}</Text>
      {/* Mid-gray stays readable on both light and dark Host themes. */}
      <Text
        textStyle={{
          fontSize: 13,
          color: disabled ? DISABLED_DESCRIPTION_COLOR : '#8E8E93',
        }}
      >
        {description}
      </Text>
    </Column>
    {Platform.OS === 'ios' ? <Spacer flexible /> : null}
    <Switch value={value} onValueChange={onValueChange} disabled={disabled} />
  </Row>
)
