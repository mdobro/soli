import { Platform } from 'react-native'
import { Column, Row, Spacer, Switch, Text } from '@expo/ui'
import { weight } from '@expo/ui/jetpack-compose/modifiers'

type DescribedSwitchRowProps = {
  label: string
  description: string
  value: boolean
  onValueChange: (value: boolean) => void
}

// Settings row: label + secondary description + trailing switch. Composed from
// @expo/ui primitives (the DrawCountPreference pattern) instead of the
// universal ListItem: FieldGroup.Section on Android already wraps every row in
// a Compose ListItem, so nesting another ListItem would double-wrap paddings.
// Layout note: on Android the label column takes the leftover width via a
// Compose weight modifier (weighted children measure LAST, so the switch keeps
// its intrinsic size and long descriptions wrap instead of squeezing it out);
// on iOS the SwiftUI HStack handles that naturally with a flexible spacer.
export const DescribedSwitchRow = ({
  label,
  description,
  value,
  onValueChange,
}: DescribedSwitchRowProps) => (
  <Row alignment="center" spacing={12}>
    <Column spacing={2} modifiers={Platform.OS === 'android' ? [weight(1)] : undefined}>
      <Text>{label}</Text>
      {/* Mid-gray stays readable on both light and dark Host themes. */}
      <Text textStyle={{ fontSize: 13, color: '#8E8E93' }}>{description}</Text>
    </Column>
    {Platform.OS === 'ios' ? <Spacer flexible /> : null}
    <Switch value={value} onValueChange={onValueChange} />
  </Row>
)
