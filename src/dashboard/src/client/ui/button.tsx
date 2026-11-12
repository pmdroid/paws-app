import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import * as React from "react";

import { cn } from "./utils";

const buttonVariants = cva(
  "inline-flex max-w-full shrink-0 items-center justify-center whitespace-normal text-center leading-5 rounded-base text-sm font-medium ring-offset-secondary-background transition-colors gap-2 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-disabled:pointer-events-none data-disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-main text-main-foreground hover:bg-main/90",
        noShadow: "bg-main text-main-foreground hover:bg-main/90",
        neutral: "border border-border bg-secondary-background text-foreground hover:bg-accent",
        reverse: "text-foreground hover:bg-accent",
        outline: "border border-border bg-secondary-background text-foreground hover:bg-accent",
        ghost: "text-foreground hover:bg-accent",
      },
      size: {
        default: "min-h-control px-4 py-1.5",
        xs: "min-h-control gap-1.5 px-2.5 py-1",
        sm: "min-h-control px-3 py-1.5",
        lg: "min-h-control px-6 py-2",
        icon: "size-control",
        "icon-xs": "size-control",
        "icon-sm": "size-control",
        "icon-lg": "size-control",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof ButtonPrimitive> & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
