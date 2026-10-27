import React from "react";

/**
 * 品牌图标：与活动栏 assets/icon.svg 同源（对话气泡 + 双星光）。
 * 单色 currentColor 跟随主题染色，不依赖系统 emoji 字体（麒麟缺 emoji 字体会渲染空白块）。
 */
export const BrandIcon: React.FC<{ size?: number }> = ({ size = 16 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    style={{ display: "block", flexShrink: 0 }}
    aria-hidden="true"
  >
    <path
      fill="currentColor"
      fillRule="evenodd"
      d="M6.5 4.5
        H17.5
        Q21.5 4.5 21.5 8.5
        V14.5
        Q21.5 18.5 17.5 18.5
        H12.2
        L7.4 21.95
        Q7 22.28 7 21.75
        V18.45
        Q2.5 18.1 2.5 14.5
        V8.5
        Q2.5 4.5 6.5 4.5
        Z
        M10.5 7.5
        Q10.5 11.5 14.5 11.5
        Q10.5 11.5 10.5 15.5
        Q10.5 11.5 6.5 11.5
        Q10.5 11.5 10.5 7.5
        Z
        M16.5 5.2
        Q16.5 7 18.3 7
        Q16.5 7 16.5 8.8
        Q16.5 7 14.7 7
        Q16.5 7 16.5 5.2
        Z"
    />
    <path fill="currentColor" d="M6.6 18 L6.6 21.9 Q6.6 22.45 7.15 22.2 L12.4 18 Z" />
  </svg>
);
