"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cva, type VariantProps } from "class-variance-authority";

import * as React from "react";

import { cn } from "./utils";

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn(
        "w-full min-w-0 data-[orientation=vertical]:flex data-[orientation=vertical]:items-start data-[orientation=vertical]:gap-2",
        className,
      )}
      {...props}
    />
  );
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex items-center justify-center text-foreground data-[orientation=vertical]:h-fit data-[orientation=vertical]:flex-col data-[orientation=vertical]:items-stretch",
  {
    variants: {
      variant: {
        default:
          "max-w-full gap-1 border-b border-border data-[orientation=vertical]:border-r data-[orientation=vertical]:border-b-0",
        line: "max-w-full gap-1 border-b border-border data-[orientation=vertical]:border-r data-[orientation=vertical]:border-b-0",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function TabsList({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Tab>) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "relative -mb-px inline-flex min-h-control min-w-0 items-center justify-center whitespace-normal border-b-2 border-transparent px-3 py-1.5 gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-disabled:pointer-events-none data-disabled:opacity-50 data-active:border-foreground data-active:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "data-[orientation=vertical]:-mr-px data-[orientation=vertical]:mb-0 data-[orientation=vertical]:w-full data-[orientation=vertical]:justify-start data-[orientation=vertical]:border-b-0 data-[orientation=vertical]:border-r-2",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Panel>) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn(
        "mt-2 ring-offset-secondary-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 data-[orientation=vertical]:mt-0 data-[orientation=vertical]:flex-1",
        className,
      )}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants };
