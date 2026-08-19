"use client"

import * as React from "react"
import { format } from "date-fns"
import { Calendar as CalendarIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Input } from "@/components/ui/input"

interface DateTimePickerProps {
  value?: Date
  onChange?: (date: Date | undefined) => void
  placeholder?: string
  disabled?: boolean
  className?: string
}

export function DateTimePicker({
  value,
  onChange,
  placeholder = "Pick a date and time",
  disabled = false,
  className,
}: DateTimePickerProps) {
  const [selectedDate, setSelectedDate] = React.useState<Date | undefined>(value)
  const [timeValue, setTimeValue] = React.useState<string>(
    value ? format(value, "HH:mm") : "00:00"
  )

  // Update internal state when value prop changes
  React.useEffect(() => {
    setSelectedDate(value)
    if (value) {
      setTimeValue(format(value, "HH:mm"))
    }
  }, [value])

  const handleTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = e.target.value
    setTimeValue(time)

    if (!selectedDate) {
      return
    }

    const [hours, minutes] = time.split(":").map((str) => parseInt(str, 10))
    const newDate = new Date(selectedDate)
    newDate.setHours(hours, minutes, 0, 0)

    setSelectedDate(newDate)
    onChange?.(newDate)
  }

  const handleDaySelect = (date: Date | undefined) => {
    if (!date) {
      setSelectedDate(undefined)
      onChange?.(undefined)
      return
    }

    // Parse time and apply to selected date
    const [hours, minutes] = timeValue.split(":").map((str) => parseInt(str, 10))
    const newDate = new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      hours,
      minutes,
      0,
      0
    )

    setSelectedDate(newDate)
    onChange?.(newDate)
  }

  const handleClear = () => {
    setSelectedDate(undefined)
    setTimeValue("00:00")
    onChange?.(undefined)
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              "w-full justify-start text-left font-normal",
              !selectedDate && "text-muted-foreground"
            )}
            disabled={disabled}
          >
            <CalendarIcon className="mr-2 h-4 w-4" />
            {selectedDate ? (
              format(selectedDate, "PPP HH:mm")
            ) : (
              <span>{placeholder}</span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <div className="p-3 space-y-3">
            <Calendar
              mode="single"
              selected={selectedDate}
              onSelect={handleDaySelect}
              initialFocus
            />
            <div className="flex items-center gap-2 border-t pt-3">
              <label htmlFor="time-picker" className="text-sm font-medium">
                Time:
              </label>
              <Input
                id="time-picker"
                type="time"
                value={timeValue}
                onChange={handleTimeChange}
                className="w-auto flex-1"
                disabled={disabled}
              />
            </div>
            {selectedDate && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleClear}
                className="w-full"
              >
                Clear
              </Button>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
