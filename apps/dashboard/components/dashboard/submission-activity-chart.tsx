"use client"

import { formatDate } from "@sendcms/i18n"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@sendcms/ui"

import type { DayCount } from "@sendcms/analytics"
import { useLocale } from "@/components/dashboard/translation-provider"

/** The chart series label is passed in already translated by the
    calling page (overview / analytics) — the chart itself owns no
    dictionary, so it stays usable from either domain. */
export function SubmissionActivityChart({
  data,
  seriesLabel,
}: {
  data: DayCount[]
  seriesLabel: string
}) {
  const locale = useLocale()
  const chartConfig: ChartConfig = {
    count: {
      label: seriesLabel,
      color: "var(--chart-1)",
    },
  }
  const formatted = data.map((d) => ({
    ...d,
    label: formatDate(locale, new Date(`${d.date}T00:00:00Z`), {
      month: "short",
      day: "numeric",
    }),
  }))

  return (
    <ChartContainer config={chartConfig} className="h-48 w-full">
      <AreaChart
        data={formatted}
        margin={{ top: 4, right: 4, left: -20, bottom: 0 }}
      >
        <defs>
          <linearGradient id="submissionGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--chart-1)" stopOpacity={0.2} />
            <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
        />
        <YAxis tickLine={false} axisLine={false} allowDecimals={false} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Area
          type="monotone"
          dataKey="count"
          stroke="var(--chart-1)"
          fill="url(#submissionGradient)"
          strokeWidth={2}
        />
      </AreaChart>
    </ChartContainer>
  )
}
