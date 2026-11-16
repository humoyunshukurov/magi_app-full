// same tap animation as the web frontend

import { motion, type HTMLMotionProps } from "framer-motion";
import type { ReactNode } from "react";

export function AnimatedButton({ children, className, ...props }: HTMLMotionProps<"button"> & { children?: ReactNode }) {
  return (
    <motion.button whileTap={{ scale: 0.97 }} className={className} {...props}>
      {children}
    </motion.button>
  );
}
