// Same tap-scale micro-interaction as the MAGI web frontend's AnimatedButton (magi_ap_test) -
// no AnimatedLink here, since this app has no router to link between pages.

import { motion, type HTMLMotionProps } from "framer-motion";
import type { ReactNode } from "react";

export function AnimatedButton({ children, className, ...props }: HTMLMotionProps<"button"> & { children?: ReactNode }) {
  return (
    <motion.button whileTap={{ scale: 0.97 }} className={className} {...props}>
      {children}
    </motion.button>
  );
}
