// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Like { function balanceOf(address account) external view returns (uint256); function approve(address spender, uint256 amount) external returns (bool); }
interface IPermit2Like { function approve(address token, address spender, uint160 amount, uint48 expiration) external; }

// READ-ONLY SIMULATION HELPER. It is never deployed: it is injected as `code` in an eth_call state override, where it plays the
// trader. It runs one Universal Router program exactly as a wallet would send it, and reports how the trader's balances moved.
// The program's recipient must be this contract's own address. Nothing here can move funds on a real network.
contract SwapSimulator {
    struct Result { uint256 inBefore; uint256 inAfter; uint256 outBefore; uint256 outAfter; uint256 gasUsed; }

    receive() external payable {}

    function simulate(address router, bytes calldata data, uint256 value, address tokenIn, address tokenOut, address permit2, uint160 permitAmount)
        external payable returns (Result memory r)
    {
        r.inBefore = IERC20Like(tokenIn).balanceOf(address(this));
        r.outBefore = IERC20Like(tokenOut).balanceOf(address(this));
        if (permit2 != address(0)) {
            // ERC-20 input: approve Permit2 for exactly this amount, then Permit2 for the router for exactly this amount.
            IERC20Like(tokenIn).approve(permit2, permitAmount);
            IPermit2Like(permit2).approve(tokenIn, router, permitAmount, uint48(block.timestamp + 3600));
        }
        uint256 before = gasleft();
        (bool ok, bytes memory ret) = router.call{value: value}(data);
        r.gasUsed = before - gasleft();
        if (!ok) { assembly { revert(add(ret, 32), mload(ret)) } }
        r.inAfter = IERC20Like(tokenIn).balanceOf(address(this));
        r.outAfter = IERC20Like(tokenOut).balanceOf(address(this));
    }
}
